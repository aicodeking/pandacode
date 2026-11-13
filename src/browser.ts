import './browser.css';
import { call, preview, subscribe } from './bridge';
import { escape, icon, isImeKey } from './dom';
import { mountJevLive, type JevLiveView } from './jev-live';
import { pageZoom } from './ui-size';
import type { BrowserAttachment, BrowserBounds, BrowserElement, BrowserScreenshot, BrowserStatus, LocalServer } from './types';
import { createBrowserPresentation, snapshotBrowser, type BrowserPresentation, type BrowserAdmission } from './extensions/browser';
import { applyBrowserPresentation, componentProviders, componentSelection } from './extensions/replacement';
import { extensionsSnapshot, onExtensionsChanged } from './extensions/manager';
import { applyControlOrder, applyControlVisibility, layout } from './extensions/layout-host';
import { BROWSER_CONTROLS } from './extensions/surfaces';
import { mountExtensionActions } from './extensions/header';
import { openContextActions } from './extensions/context-actions';

export interface BrowserPanel { close(): Promise<void>; refresh(): void; navigate(url: string): Promise<BrowserStatus>; watchJev(runId: string): Promise<void>; presentation(): BrowserPresentation; dispatch(action: unknown): BrowserAdmission; }
type Options = { project?: string; task(): string | undefined; session(): string | undefined; navigated?(url: string): void; attach(taskId: string, attachment: BrowserAttachment): void; close(): void; test?(url?: string, anchor?: HTMLElement): void; };
// Tauri 2 packs a Linux child webview into the window's GtkBox below the app
// instead of placing it at the given bounds (set_bounds is a no-op there), so
// the guest lands in a bottom pane and window resizes fight over the split.
// ponytail: system browser on Linux; embed again once the guest sits in a GtkOverlay.
export const embedsGuest = (platform: string, sample: boolean): boolean => sample || !/Linux/i.test(platform);
const LINUX_NOTICE = 'Opened in your system browser. Linux cannot show pages inside this pane yet.';
const emptyStatus = (): BrowserStatus => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, picking: false });

export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 8192) throw new Error('Enter a website address or localhost port.');
  const candidate = /^\d{2,5}$/.test(value) ? `http://localhost:${value}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value
    : /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value) ? `http://${value}`
    : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Use an HTTP or HTTPS address without embedded credentials.');
  return url.href;
}

export async function mountBrowser(host: HTMLElement, options: Options): Promise<BrowserPanel> {
  let disposed = false, status = emptyStatus(), home = true, busy = false, request = 0, frame = 0;
  let pickTask: string | undefined, servers: LocalServer[] = [], lastBounds = '';
  let watching = false, jevAvailable = false, live: JevLiveView | undefined;
  let operations = Promise.resolve();
  const context = crypto.randomUUID(), guest = crypto.randomUUID(), project = options.project || 'none', session = options.session() || 'none', applied = new Set<string>();
  let revision = 0, picked = { tag: '', text: '' };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = operations.then(work); operations = next.then(() => {}, () => {}); return next;
  };
  const tool = (action: string, label: string, symbol: string) => `<button type="button" class="browser-tool" data-browser-action="${action}" aria-label="${label}" title="${label}">${icon(symbol)}</button>`;
  host.innerHTML = `<div class="browser-toolbar">
    ${tool('back', 'Go back', 'back')}${tool('forward', 'Go forward', 'forward')}${tool('reload', 'Reload page', 'refresh')}
    <form class="browser-address"><span>${icon('globe')}</span><input aria-label="Browser URL" placeholder="Enter URL or localhost port" autocomplete="off" spellcheck="false" inputmode="url"><button type="submit" aria-label="Open URL">${icon('arrow')}</button></form>
    ${tool('pick', 'Attach an element', 'select')}${tool('capture', 'Attach screenshot', 'camera')}${options.test ? tool('test', 'Test with Jev', 'spark') : ''}${tool('close', 'Close browser', 'close')}
   </div><div class="browser-location" tabindex="0" role="group" aria-label="Browser page actions"><button type="button" data-browser-action="home">${icon('server')}Local servers</button><span class="browser-page-title"></span><button type="button" class="browser-watch-jev" data-browser-action="watch-jev" hidden>${icon('spark')}Watch Jev</button></div>
  <div class="browser-notice" role="status" hidden></div><div class="browser-viewport"><section class="browser-home"><div class="browser-home-heading"><h2>Local servers</h2>${tool('refresh-ports', 'Refresh local servers', 'refresh')}</div><div class="browser-servers" aria-label="Local servers"></div><p class="browser-home-hint">Open a server, or enter any website above.</p></section><div class="browser-guest-placeholder" hidden></div></div>`;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const address = query<HTMLInputElement>('.browser-address input'), viewport = query('.browser-viewport');
  // Subscriptions mount asynchronously. Never expose a submit/close control before
  // its listeners exist (an early form submit otherwise navigates the host page).
  address.disabled = true;
  host.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  const notice = query('.browser-notice'), placeholder = query('.browser-guest-placeholder');
  const button = (action: string) => query<HTMLButtonElement>(`[data-browser-action="${action}"]`);
  function tell(message: string): void { notice.textContent = message; notice.hidden = !message; scheduleBounds(); }
  function fail(error: unknown): void { if (!disposed) tell(error instanceof Error ? error.message : String(error)); }
  function updateControls(): void {
    if (disposed) return;
    revision++;
    button('back').disabled = watching || home || !status.canGoBack || busy;
    button('forward').disabled = watching || home || !status.canGoForward || busy;
    button('reload').disabled = watching || home || busy;
    for (const action of ['pick', 'capture']) button(action).disabled = watching || home || status.loading || busy || !options.task();
    button('pick').setAttribute('aria-pressed', String(status.picking));
    query('.browser-page-title').textContent = watching || home ? '' : status.title || status.url;
    query('.browser-page-title').title = watching ? '' : status.url;
    query('.browser-home').hidden = watching || !home;
    placeholder.hidden = watching || home;
    // While Jev drives, only the navigation hides: Test with Jev and Close browser stay in the row.
    query('.browser-toolbar').toggleAttribute('data-watching', watching);
    button('watch-jev').hidden = watching || !jevAvailable;
    // The home view's own heading names it; the way back only shows away from it.
    button('home').hidden = watching || home;
    host.classList.toggle('browser-loading', !watching && status.loading);
    if (document.activeElement !== address) address.value = home ? '' : status.url;
    if (status.picking) tell('Click an element to attach it. Press Esc to cancel.');
    else if (notice.textContent?.startsWith('Click an element')) tell('');
  }
  // The native view is placed in window points; under interface zoom one CSS pixel is `pageZoom()` points.
  function bounds(): BrowserBounds { const rect = viewport.getBoundingClientRect(), zoom = pageZoom(); return { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }; }
  // The native window owns visibility. WebKit may mark the host document hidden
  // when its sibling guest gains focus, even though the window remains on screen.
  function obscured(rect: BrowserBounds): boolean {
    // A modal's scrim covers the whole app. Other menus only obscure the guest
    // when they overlap it; composer completions normally sit beside the browser.
    // So does the full-page Settings.
    // So does a closing inspector: the native view leaves at once instead of hanging over the fading panel.
    if (document.querySelector('dialog[open], #settings-page:not([hidden]), #inspector[data-leaving]')) return true;
    return [...document.querySelectorAll<HTMLElement>('.floating-menu:not([aria-hidden="true"])')].some(menu => {
      const box = menu.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(menu).visibility !== 'hidden'
        && box.left < rect.x + rect.width && box.right > rect.x
        && box.top < rect.y + rect.height && box.bottom > rect.y;
    });
  }
  function syncBounds(force = false): void {
    if (disposed || home) return;
    const rect = bounds(), visible = host.checkVisibility() && !watching && !obscured(rect) && rect.width > 1 && rect.height > 1;
    const key = JSON.stringify({ ...rect, visible });
    if (!force && key === lastBounds) return;
    // Remember attempted geometry even on failure: rendering its notice must
    // not create a timer retry loop. Reload/focus/navigation explicitly retry.
    lastBounds = key;
    void enqueue(async () => { if (!disposed) await call('browser_bounds', { bounds: rect, visible }); }).catch(fail);
  }
  function scheduleBounds(): void {
    if (disposed || frame) return;
    // WebKit can pause the host view's animation frames while the guest has focus.
    frame = window.setTimeout(() => {
      frame = 0;
      syncBounds();
    }, 16);
  }
  function renderServers(): void {
    query('.browser-servers').innerHTML = servers.length ? servers.map(server => `<button class="browser-server" type="button" data-server-url="${escape(server.url)}"><span class="browser-server-icon">${icon('terminal')}</span><span><strong>${escape(server.process || 'Local server')}</strong><small>${escape(new URL(server.url).host)}</small></span><span class="browser-server-dot" aria-label="Listening"></span>${icon('chevron')}</button>`).join('') : '<div class="browser-no-servers">No local servers found.<small>Start your app in the terminal, then refresh.</small></div>';
  }
  async function refreshServers(): Promise<void> {
    const ticket = ++request;
    button('refresh-ports').disabled = true;
    try { const found = await call<LocalServer[]>('list_local_servers'); if (!disposed && ticket === request) { servers = found; renderServers(); } }
    catch (error) { if (!disposed && ticket === request) { renderServers(); fail(error); } }
    finally { if (!disposed && ticket === request) button('refresh-ports').disabled = false; }
  }
  async function navigate(input: string): Promise<void> {
    const url = normalizeUrl(input);
    picked = { tag: '', text: '' };
    if (!embedsGuest(navigator.platform, preview)) { await call('open_external_url', { url }); if (!disposed) { address.value = ''; tell(LINUX_NOTICE); } return; }
    options.navigated?.(url);
    live?.leave();
    busy = true; tell(''); updateControls();
    try {
      const next = await enqueue(() => call<BrowserStatus>('browser_open', { url, bounds: bounds() }));
      if (disposed) return;
      status = next; home = false; pickTask = undefined; lastBounds = ''; options.navigated?.(status.url);
      address.blur();
      if (preview) showSamplePage();
    } finally {
      busy = false; updateControls();
      // Restored threads must show their new guest immediately. WebKit may
      // suspend the host's timer after the sibling guest gains focus.
      syncBounds(true);
    }
  }
  function showSamplePage(): void {
    placeholder.innerHTML = `<div class="browser-preview-label">Browser preview · sample page</div><div class="browser-sample"><span class="browser-sample-kicker">LOCAL PREVIEW</span><h2>Your app, right here.</h2><p>Inspect the page beside your conversation.</p><button type="button" class="browser-sample-button">Try the interaction</button></div>`;
  }
  function attachElement(element: BrowserElement): void {
    if (disposed || !pickTask) return;
    // Only explicitly picked, non-sensitive plain text is eligible. Never expose HTML/selectors.
    picked = /^(input|textarea|select|option|iframe|script)$/i.test(element.tag) ? { tag: '', text: '' } : { tag: element.tag.slice(0, 64), text: element.text.slice(0, 512) };
    const task = pickTask; pickTask = undefined; status.picking = false; updateControls();
    try { options.attach(task, { ...element, kind: 'element', id: crypto.randomUUID() }); tell('Element attached to your message.'); }
    catch (error) { fail(error); }
  }
  const unlisten = await Promise.all([
    subscribe('browser-state', next => { if (disposed || home && !busy) return; if (next.url !== status.url) picked = { tag: '', text: '' }; status = next; if (status.url) options.navigated?.(status.url); updateControls(); scheduleBounds(); }),
    subscribe('browser-element', attachElement),
  ]);
  const liveHost = document.createElement('section'); viewport.append(liveHost);
  live = await mountJevLive(liveHost, { session: options.session, visible: () => host.checkVisibility(), failed: fail, returned() { button('watch-jev').focus({ preventScroll: true }); }, changed(next, available) {
    if (disposed) return;
    watching = next; jevAvailable = available;
    if (watching && status.picking) {
      pickTask = undefined; status.picking = false;
      void enqueue(() => call('browser_pick', { enabled: false })).catch(fail);
    }
    updateControls(); syncBounds();
  } });
  async function act(action: string, anchor?: HTMLElement): Promise<void> {
    if (disposed) return;
    if (action === 'test') { options.test?.(watching ? live?.url() : status.url || undefined, anchor); return; }
    if (action === 'watch-jev') { await live?.watch(); return; }
    if (action === 'close') { options.close(); return; }
    if (action === 'refresh-ports') { await refreshServers(); return; }
    if (action === 'home') { options.navigated?.(''); live?.leave(); await enqueue(() => call('browser_close')); if (disposed) return; home = true; status = emptyStatus(); pickTask = undefined; tell(''); updateControls(); await refreshServers(); return; }
    if (action === 'pick') {
      const target = options.task(); if (!target) return;
      pickTask = status.picking ? undefined : target;
      await enqueue(() => call('browser_pick', { enabled: !status.picking }));
      return;
    }
    if (action === 'capture') {
      const target = options.task(); if (!target) return;
      busy = true; tell(''); updateControls();
      try { const screenshot = await enqueue(() => call<BrowserScreenshot>('browser_capture')); options.attach(target, { ...screenshot, kind: 'screenshot' }); if (!disposed) tell('Screenshot attached to your message.'); }
      finally { busy = false; updateControls(); }
      return;
    }
    await enqueue(() => call('browser_action', { action: action === 'reload' && status.loading ? 'stop' : action }));
    // An explicit page action is also a recovery point for native visibility;
    // identical geometry must not keep a hidden guest hidden after a task switch.
    syncBounds(true);
  }
  function presentation(): BrowserPresentation {
    let url = ''; try { const safe = new URL(status.url); safe.username = ''; safe.password = ''; safe.search = ''; safe.hash = ''; url = safe.href.slice(0, 8192); } catch { /* Home has no URL. */ }
    return snapshotBrowser({ contractVersion: 1, context, guest, project, session, revision, url, home, loading: status.loading, busy, watching, visible: !disposed && host.checkVisibility() && !obscured(bounds()), embedded: embedsGuest(navigator.platform, preview), canGoBack: status.canGoBack, canGoForward: status.canGoForward, picking: status.picking, picked });
  }
  function authority() {
    const provider = componentSelection.resolve('panda.browser', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.manifest.id === provider?.id.split('/')[0]);
    return { owner: provider?.id ?? '', active: !disposed && Boolean(provider && host.dataset.browserProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')) };
  }
  function dispatch(input: unknown): BrowserAdmission {
    const auth = authority();
    const slot = createBrowserPresentation(presentation(), auth.owner, presentation, authority, action => {
      revision++; picked = { tag: '', text: '' };
      void (action.controlId === 'navigate' ? navigate(action.value) : act(action.controlId)).catch(fail);
    }, applied);
    // Validate URLs before admission, without reading accessors in untrusted input.
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'controlId')?.value === 'navigate') {
      const value = Object.getOwnPropertyDescriptor(input, 'value')?.value;
      try { if (typeof value !== 'string') throw Error(); normalizeUrl(value); } catch { slot.dispose(); return { ok: false, reason: 'InvalidArguments' }; }
    }
    const action = input as { controlId?: string };
    if (auth.active && action && ['pick', 'capture'].includes(Object.getOwnPropertyDescriptor(action, 'controlId')?.value) && !options.task()) { slot.dispose(); return { ok: false, reason: 'UnsupportedCapability' }; }
    if (auth.active && action && (Object.getOwnPropertyDescriptor(action, 'controlId')?.value === 'test' && !options.test || Object.getOwnPropertyDescriptor(action, 'controlId')?.value === 'watch-jev' && !jevAvailable)) { slot.dispose(); return { ok: false, reason: 'UnsupportedCapability' }; }
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  function configure(): void {
    if (disposed) return;
    revision++;
    applyBrowserPresentation(host);
    const bindings = BROWSER_CONTROLS['panda.browser.controls'].map(([id]) => [`panda.browser.controls/${id}`, id === 'address' ? query('.browser-address') : host.querySelector<HTMLElement>(`[data-browser-action="${id}"]`)] as const);
    applyControlVisibility(bindings, () => [...host.querySelectorAll<HTMLElement>('input,button')].find(node => !node.closest('[inert]') && node.checkVisibility()) ?? document.querySelector('#prompt'));
    applyControlOrder('panda.browser.controls', bindings);
    syncBounds(true);
  }
  const stopExtensions = onExtensionsChanged(configure), stopLayout = layout.subscribe(configure);
  window.addEventListener('pandacode-components-change', configure);
  const actionContext = () => ({ projectId: project, sessionId: session, revision });
  const stopActions = mountExtensionActions(query('.browser-toolbar'), 'panda.browser.actions', actionContext, tell);
  let closeContext: (() => void) | undefined;
  const hasContextActions = () => !extensionsSnapshot().safeMode && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.permissions?.includes('ui.contribute') && item.manifest.contributes.menus?.some(menu => menu.location === 'panda.browser.context'));
  function openBrowserContext(point?: { x: number; y: number }): void {
    closeContext?.();
    const captured = revision;
    closeContext = openContextActions(query('.browser-location'), 'panda.browser.context', actionContext(), { title: 'Browser', items: [], onSelect() {}, notify: tell, point, isAlive: () => !disposed && revision === captured && host.checkVisibility() });
  }
  function contextMenu(event: MouseEvent): void {
    if (!hasContextActions() || !(event.target instanceof Element) || !event.target.closest('.browser-location')) return;
    event.preventDefault(); openBrowserContext({ x: event.clientX, y: event.clientY });
  }
  host.addEventListener('contextmenu', contextMenu);
  function click(event: MouseEvent): void {
    const target = (event.target as Element).closest<HTMLElement>('[data-browser-action],[data-server-url]');
    if (target) { event.preventDefault(); event.stopPropagation(); if (target instanceof HTMLButtonElement && target.disabled) return; void (target.dataset.serverUrl ? navigate(target.dataset.serverUrl) : act(target.dataset.browserAction!, target)).catch(fail); }
    else if (preview && status.picking && (event.target as Element).closest('.browser-sample')) {
      const element = event.target as HTMLElement;
      attachElement({ url: status.url, title: status.title, tag: element.tagName.toLowerCase(), selector: element.className ? '.' + element.className : element.tagName.toLowerCase(), text: element.textContent?.slice(0, 4000) || '', html: element.outerHTML.slice(0, 8000), bounds: { x: 0, y: 0, width: 180, height: 44 } });
      void enqueue(() => call('browser_pick', { enabled: false })).catch(fail);
    }
  }
  function submit(event: SubmitEvent): void { if (event.target === query('.browser-address')) { event.preventDefault(); event.stopPropagation(); void navigate(address.value).catch(fail); } }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && isImeKey(event)) { event.preventDefault(); return; }
    if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && event.target instanceof Element && event.target.closest('.browser-location') && !isImeKey(event) && hasContextActions()) { event.preventDefault(); event.stopPropagation(); openBrowserContext(); return; }
    if (event.key === 'Escape' && status.picking) { event.preventDefault(); event.stopPropagation(); pickTask = undefined; void enqueue(() => call('browser_pick', { enabled: false })).catch(fail); }
  }
  host.addEventListener('click', click); host.addEventListener('submit', submit); host.addEventListener('keydown', keydown);
  const resize = new ResizeObserver(scheduleBounds); resize.observe(viewport);
  const menus = new Set<Element>();
  function observeMenus(): void {
    const current = new Set(document.querySelectorAll('.floating-menu'));
    for (const menu of menus) if (!current.has(menu)) { resize.unobserve(menu); menus.delete(menu); }
    for (const menu of current) if (!menus.has(menu)) { menus.add(menu); resize.observe(menu); }
  }
  // Native guests sit above HTML. Recheck overlap when menus move, grow, settle
  // from their entrance animation, or dismiss; unrelated streaming DOM is ignored.
  const overlays = new MutationObserver(records => {
    // Dismissal becomes effective before the menu's exit animation finishes.
    // Do not wait for WebKit's animation/timer callbacks to reveal the guest.
    const selector = '.floating-menu,dialog,#settings-page,#inspector';
    if (records.some(record => record.type === 'attributes'
      ? record.target === document.documentElement || record.target instanceof Element && record.target.matches(selector)
      : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) {
      observeMenus(); syncBounds();
    }
  });
  overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'open', 'style', 'hidden', 'data-popover-state', 'data-leaving'] });
  overlays.observe(document.documentElement, { attributes: true, attributeFilter: ['data-native-material', 'data-theme'] });
  observeMenus();
  window.addEventListener('resize', scheduleBounds);
  function restoreVisibility(): void { if (!document.hidden) syncBounds(true); }
  window.addEventListener('focus', restoreVisibility);
  document.addEventListener('visibilitychange', restoreVisibility);
  address.disabled = false;
  host.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
  updateControls(); configure(); void refreshServers(); if (!watching && host.checkVisibility()) address.focus();
  return {
    presentation, dispatch,
    async navigate(url) {
      if (disposed) throw new Error('Browser is closed.');
      await navigate(url);
      // Agents must not drive a page they cannot read; tell them where it went.
      if (!embedsGuest(navigator.platform, preview)) throw new Error(LINUX_NOTICE);
      return status;
    },
    async watchJev(runId) { if (disposed) throw new Error('Browser is closed.'); await live?.watch(runId); },
    refresh() { live?.refresh(); if (pickTask && pickTask !== options.task()) { pickTask = undefined; void enqueue(() => call('browser_pick', { enabled: false })).catch(fail); } updateControls(); syncBounds(true); },
    async close() {
      disposed = true; ++request; clearTimeout(frame); resize.disconnect(); menus.clear(); overlays.disconnect();
      stopExtensions(); stopLayout(); stopActions(); closeContext?.();
      host.removeEventListener('contextmenu', contextMenu); window.removeEventListener('pandacode-components-change', configure);
      // Hide promptly even when a navigation operation has not returned yet.
      const hiding = call('browser_bounds', { bounds: bounds(), visible: false }).catch(() => {});
      unlisten.forEach(stop => stop()); window.removeEventListener('resize', scheduleBounds);
      window.removeEventListener('focus', restoreVisibility); document.removeEventListener('visibilitychange', restoreVisibility);
      host.removeEventListener('click', click); host.removeEventListener('submit', submit); host.removeEventListener('keydown', keydown);
      await Promise.all([hiding, live?.close(), enqueue(() => call('browser_close'))]); host.replaceChildren();
    },
  };
}
