/** Host entry bindings only. Packages still receive JSON, never this transport or DOM. */
import './windows.css';
import { call, preview } from '../bridge';
import { icon } from '../dom';
import { mountExtensionActions } from './header';
import { loadWindowExtensions, loadExtensions, onExtensionsChanged, extensionIdentity, extensionsSnapshot } from './manager';
import { createDeclarativeActivation } from './activation';
import { layout } from './layout-host';
import { openExtensionDialog } from './dialogs';
import { surfaceWindow, type WindowActionLocation } from './window-surfaces';
import type { ExtensionAction } from './manager';
import type { Json } from './contracts';

type ActionRequest = { surfaceId: string; id: string; version: string };
async function listen<T>(name: string, listener: (value: T) => void, compact = false): Promise<() => void> {
  if (preview && compact) {
    const handler = (event: Event) => listener((event as CustomEvent<T>).detail);
    window.addEventListener(`pandacode:${name}`, handler); return () => window.removeEventListener(`pandacode:${name}`, handler);
  }
  if (preview) return (await import('../preview')).listen(name, listener);
  return (await import('@tauri-apps/api/event')).listen<T>(name, event => listener(event.payload));
}
async function compactCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!preview) return call<T>(command, args);
  return (await import('./preview')).previewExtensions(command, args, (name, value) => window.dispatchEvent(new CustomEvent(`pandacode:${name}`, { detail: value }))) as T;
}

/** Only UI registrations are disposed on pagehide; no disable/uninstall or service stop occurs. */
export function mountAuxiliaryExtensions(host: HTMLElement, location: Exclude<WindowActionLocation, 'panda.tray.menu'>, recoveryHost: HTMLElement): () => void {
  let disposed = false, cleanup: (() => void) | undefined, revision = 0;
  const notice = document.createElement('p'); notice.className = 'extension-window-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
  const show = (message: string) => { notice.textContent = message; notice.hidden = false; };
  const recovery = document.createElement('button'); recovery.type = 'button'; recovery.className = 'extension-window-recovery'; recovery.setAttribute('aria-label', 'Disable extensions for this launch'); recovery.title = 'Disable extensions for this launch'; recovery.innerHTML = icon('refresh');
  host.append(notice); recoveryHost.insertBefore(recovery, recoveryHost.querySelector('button'));
  recovery.addEventListener('click', () => { void compactCall('extensions_window_recover').then(() => refresh()).catch(error => { if (!disposed) show(String(error)); }); });
  const refresh = async () => {
    if (disposed) return;
    const request = ++revision;
    try {
      const windowId = await loadWindowExtensions();
      if (disposed || request !== revision) return;
      if (windowId !== surfaceWindow(location)) throw new Error('Window identity mismatch.');
      if (!cleanup) cleanup = mountExtensionActions(host, location, () => ({ revision: 1 }), show, undefined, undefined, [], { windowId,
        invoke: (id, version) => compactCall<ExtensionAction | null>('extensions_window_action', { request: { surfaceId: location, id, version } }).then(action => action ?? undefined),
      });
      host.append(notice);
    } catch (error) { if (!disposed && request === revision) show(`Extension actions unavailable: ${String(error)}`); }
  };
  const subscriptions = [listen('extensions-changed', () => { void refresh(); }, true)];
  const storage = (event: StorageEvent) => { if (preview && (event.key === null || event.key === 'pandacode.preview.extensions.v1' || event.key === 'pandacode.preview.extensions.safe')) void refresh(); };
  window.addEventListener('storage', storage);
  const dispose = () => {
    if (disposed) return;
    disposed = true; revision++; cleanup?.(); notice.remove(); recovery.remove();
    if (preview) { try { localStorage.setItem('pandacode.preview.extensions.closed', JSON.stringify({ windowId: surfaceWindow(location), nonce: crypto.randomUUID() })); } catch { /* Closing a UI never depends on synthetic storage. */ } }
    window.removeEventListener('storage', storage); window.removeEventListener('pagehide', dispose);
    subscriptions.forEach(result => { void result.then(stop => stop()).catch(() => undefined); });
  };
  window.addEventListener('pagehide', dispose, { once: true });
  void refresh(); return dispose;
}

/** The OS menu cannot read webview storage, so the main window sends only the global presentation
 * (hidden IDs and order) of panda.tray.menu contributions. Safe mode or a rejected batch sends nothing. */
export function nativeMenuLayout(): { hidden: string[]; order: string[] } {
  const state = extensionsSnapshot();
  if (state.safeMode) return { hidden: [], order: [] };
  let ids: string[];
  try {
    const activation = createDeclarativeActivation(state, 0);
    ids = activation.entries.filter(entry => entry.menu.location === 'panda.tray.menu').map(entry => entry.menu.id);
    activation.dispose();
  } catch { return { hidden: [], order: [] }; }
  // The native tree holds at most 128 items, so neither list can usefully exceed the broker's bound.
  return { hidden: ids.filter(id => layout.isHidden(id)).slice(0, 128), order: layout.order('panda.tray.menu', ids).slice(0, 128) };
}

/** Native/compact surfaces present forms in the existing full-size host, not clipped tiny windows. */
export function mountNativeExtensionPresentation(show: (message: string) => void): () => void {
  let disposed = false, close: (() => void) | undefined, requestId = 0, originWindow: string | undefined;
  let currentOwner: string | undefined, currentIdentity: string | undefined;
  const cancel = () => { requestId++; close?.(); close = undefined; originWindow = undefined; };
  const originClosed = (event: { windowId: string }) => { if (event.windowId === originWindow) cancel(); };
  let pushed = '';
  const pushLayout = () => {
    if (disposed) return;
    const value = nativeMenuLayout(), signature = JSON.stringify(value);
    if (signature === pushed) return;
    pushed = signature;
    // A refused update keeps the previous native menu; the next change retries.
    void call('extensions_native_layout', { layout: value }).catch(() => { if (pushed === signature) pushed = ''; });
  };
  const changed = onExtensionsChanged(() => { if (currentOwner && extensionIdentity(currentOwner) !== currentIdentity) cancel(); pushLayout(); });
  const stopLayout = layout.subscribe(pushLayout);
  const present = (request: ActionRequest) => {
    const current = ++requestId, owner = request.id.split('/')[0], identity = extensionIdentity(owner);
    currentOwner = owner; currentIdentity = identity;
    originWindow = surfaceWindow(request.surfaceId);
    void call<{ owner: string; context: Record<string, Json>; action: ExtensionAction }>('extensions_present_action', { request }).then(value => {
      if (disposed || current !== requestId || identity !== extensionIdentity(owner)) return;
      close?.(); close = undefined;
      if (value.action.kind === 'showMessage') { show(value.action.message); return; }
      if (value.action.kind !== 'showDialog') return;
      const trigger = document.querySelector<HTMLElement>('#prompt') ?? document.querySelector<HTMLElement>('button');
      if (!trigger) return;
      const action = value.action;
      const transient = openExtensionDialog(action.dialog, value.context, value.owner, trigger, request.surfaceId === 'panda.tray.menu');
      close = transient.close;
      void transient.result.then(result => {
        if (close === transient.close) close = undefined;
        if (disposed || current !== requestId || identity !== extensionIdentity(owner)) return;
        originWindow = undefined;
        if (result.kind === 'confirmed') show(action.dialog.successMessage);
        else if (result.reason === 'cancel' && action.dialog.cancelMessage) show(action.dialog.cancelMessage);
      });
    }).catch(error => { if (!disposed && current === requestId) show(`Extension action unavailable: ${String(error)}`); });
  };
  const subscription = listen<ActionRequest>('extensions-present-action', present);
  const refresh = listen('extensions-changed', () => { void loadExtensions(); });
  const closed = listen<{ windowId: string }>('extensions-origin-closed', originClosed);
  const storage = (event: StorageEvent) => {
    if (!preview) return;
    if (event.key === 'pandacode.preview.extensions.presentation' && event.newValue) {
      try { present(JSON.parse(event.newValue).request); } catch { show('Extension action unavailable.'); }
    }
    if (event.key === 'pandacode.preview.extensions.closed' && event.newValue) {
      try { originClosed(JSON.parse(event.newValue)); } catch { /* Invalid synthetic events grant nothing. */ }
    }
    if (event.key === 'pandacode.preview.extensions.v1' || event.key === 'pandacode.preview.extensions.safe') void loadExtensions();
  };
  window.addEventListener('storage', storage);
  const dispose = () => { disposed = true; cancel(); changed(); stopLayout(); window.removeEventListener('storage', storage); window.removeEventListener('pagehide', dispose); [subscription, refresh, closed].forEach(result => { void result.then(stop => stop()).catch(() => undefined); }); };
  window.addEventListener('pagehide', dispose, { once: true }); pushLayout(); return dispose;
}
