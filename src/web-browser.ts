import { WebFiles } from './web-files';
import { call } from './bridge';
import { isImeKey } from './dom';
import { webJson } from './web-http';
import { mountJevLive, type JevLiveView } from './jev-live';
import type { BrowserAttachment, BrowserStatus, BrowserElement } from './types';

const FRAME_LIMIT = 5 * 1024 * 1024;
const keys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
const actions = new Set(['back', 'forward', 'reload', 'stop']);
export interface WebBrowserOptions {
  task(): string | undefined;
  session?(): string | undefined;
  navigated?(url: string): void;
  attach(task: string, attachment: BrowserAttachment): void;
  close(): void;
}
export function validateBrowserLease(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid browser lease');
  return value;
}
function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Enter an HTTP or HTTPS address.');
  const candidate = /^\d{2,5}$/.test(value) ? `http://localhost:${value}` :
    /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value :
    /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value) ? `http://${value}` :
    /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('Use HTTP or HTTPS without embedded credentials.');
  return url.href;
}
function statusValue(value: unknown): BrowserStatus {
  if (!value || typeof value !== 'object') throw Error('Invalid browser status');
  const v = value as Record<string, unknown>;
  if (typeof v.url !== 'string' || v.url.length > 4096 || typeof v.title !== 'string' || v.title.length > 300 ||
    ['loading', 'canGoBack', 'canGoForward', 'picking'].some(key => typeof v[key] !== 'boolean')) throw Error('Invalid browser status');
  return { url: v.url, title: v.title, loading: v.loading as boolean, canGoBack: v.canGoBack as boolean, canGoForward: v.canGoForward as boolean, picking: v.picking as boolean };
}
function csrf(): string {
  const item = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('pandacode_csrf='));
  return item ? decodeURIComponent(item.slice('pandacode_csrf='.length)) : '';
}

export async function mountWebBrowser(host: HTMLElement, options: WebBrowserOptions) {
  let disposed = false, lease = '', watching = false, picking = false, failed = false;
  let status: BrowserStatus = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, picking: false };
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let poll = 0, wheelTimer = 0, wheelX = 0, wheelY = 0, generation = 0;
  let refreshing: Promise<void> | undefined, readController: AbortController | undefined;
  let image: { dataUrl: string; width: number; height: number; sequence: number } | undefined;
  let live: JevLiveView | undefined;
  host.innerHTML = `<section class="web-browser-panel">
    <form data-web-browser-address><input aria-label="Browser URL" inputmode="url" autocomplete="off"><button type="submit">Open</button></form>
    <p role="status" data-web-browser-status>Enter a URL</p>
    <div class="web-browser-frame-wrap"><img alt="Remote browser frame" data-web-browser-frame tabindex="0" hidden></div>
    <div class="web-browser-controls">
      <button type="button" data-web-browser-back>Back</button><button type="button" data-web-browser-forward>Forward</button>
      <button type="button" data-web-browser-reload>Reload</button><button type="button" data-web-browser-stop>Stop</button>
      <button type="button" data-web-browser-pick>Pick element</button><button type="button" data-web-browser-inspect>Inspect</button>
      <input data-web-browser-text aria-label="Browser text input" maxlength="8192"><button type="button" data-web-browser-send>Send text</button>
      <button type="button" data-web-browser-key="Enter">Enter</button><button type="button" data-web-browser-key="Tab">Tab</button>
      <button type="button" data-web-browser-key="Escape">Esc</button>
      <button type="button" data-web-browser-scroll="-720">Scroll up</button><button type="button" data-web-browser-scroll="720">Scroll down</button>
      <button type="button" data-web-browser-capture>Attach screenshot</button><button type="button" data-web-browser-servers>Local servers</button>
      <button type="button" data-web-browser-close>Close browser</button>
    </div><nav data-web-browser-server-list aria-label="Local servers"></nav>
  </section>`;
  const panel = host.querySelector<HTMLElement>('.web-browser-panel')!;
  const frame = host.querySelector<HTMLImageElement>('[data-web-browser-frame]')!;
  const address = host.querySelector<HTMLInputElement>('[aria-label="Browser URL"]')!;
  const textInput = host.querySelector<HTMLInputElement>('[data-web-browser-text]')!;
  const message = host.querySelector<HTMLElement>('[data-web-browser-status]')!;
  const liveHost = document.createElement('section'); host.append(liveHost);
  const endpoint = (suffix = '') => `/api/pandacode/browser/${encodeURIComponent(validateBrowserLease(lease))}${suffix}`;
  const headers = (json = true): HeadersInit => ({ ...(json ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf(), 'x-request-id': crypto.randomUUID() });
  const api = async (path: string, init: RequestInit = {}) => {
    const mutation = !!init.method && init.method !== 'GET';
    let result;
    try { result = await webJson(path, init, { timeoutMs: 50000, maxBytes: 131072 }); }
    catch (error) { if (mutation) failed = true; throw error; }
    if (!result.response.ok) {
      if (mutation && result.response.status >= 500) failed = true;
      throw Error(`Browser request failed (${result.response.status})`);
    }
    return result.value;
  };
  const report = (error: unknown) => { if (!disposed) message.textContent = error instanceof Error ? error.message : 'Browser operation failed'; };
  const paint = () => {
    if (document.activeElement !== address) address.value = status.url;
    message.textContent = picking ? 'Select an element in the page.' : status.title || status.url || 'Enter a URL';
    host.querySelector<HTMLButtonElement>('[data-web-browser-back]')!.disabled = !status.canGoBack;
    host.querySelector<HTMLButtonElement>('[data-web-browser-forward]')!.disabled = !status.canGoForward;
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (queued >= 128) return Promise.reject(Error('Browser input queue is full. Wait for pending input before continuing.'));
    ++queued;
    const result = queue.then(async () => {
      if (disposed) throw Error('Browser is closed');
      if (failed) throw Error('Browser delivery is uncertain. Close and reopen the panel before sending more input.');
      return operation();
    });
    queue = result.catch(report);
    return result.finally(() => { --queued; });
  };
  const closeLease = async (id: string) => {
    await api(`/api/pandacode/browser/${encodeURIComponent(validateBrowserLease(id))}`, { method: 'DELETE', headers: headers(false) });
  };
  const showJev = (active: boolean) => { watching = active; panel.hidden = active; liveHost.hidden = !active; };
  const refreshFrame = (): Promise<void> => {
    if (!lease || disposed || watching) return Promise.resolve();
    if (refreshing) return refreshing;
    const id = lease, ticket = generation;
    refreshing = (async () => {
      const next = await api(endpoint('/status'));
      if (disposed || ticket !== generation || id !== lease) return;
      status = statusValue(next); paint();
      const controller = new AbortController(); readController = controller;
      const timer = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(endpoint('/frame'), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error(`Browser frame failed (${response.status})`);
        if (response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png') { await response.body?.cancel(); throw Error('Browser frame must be PNG'); }
        if (Number(response.headers.get('content-length') ?? 0) > FRAME_LIMIT) { await response.body?.cancel(); throw Error('Browser frame exceeds limit'); }
        const width = Number(response.headers.get('x-browser-width')), height = Number(response.headers.get('x-browser-height')), sequence = Number(response.headers.get('x-browser-sequence'));
        if (![width, height, sequence].every(Number.isSafeInteger) || width < 1 || height < 1 || width > 8192 || height > 8192 || sequence < 1) { await response.body?.cancel(); throw Error('Invalid browser frame metadata'); }
        const reader = response.body?.getReader(); if (!reader) throw Error('Browser frame is empty');
        let length = 0; const chunks: Uint8Array[] = [];
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > FRAME_LIMIT) { await reader.cancel(); throw Error('Browser frame exceeds limit'); }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (length < 33 || signature.some((value, index) => bytes[index] !== value) || new DataView(bytes.buffer).getUint32(16) !== width || new DataView(bytes.buffer).getUint32(20) !== height) throw Error('Invalid PNG frame dimensions');
        if (disposed || watching || ticket !== generation || id !== lease || sequence <= (image?.sequence ?? 0)) return;
        let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        image = { dataUrl: `data:image/png;base64,${btoa(binary)}`, width, height, sequence };
        frame.src = image.dataUrl; frame.hidden = false;
      } catch (error) { if (!disposed) throw controller.signal.aborted ? Error('Browser frame timed out') : error; }
      finally { window.clearTimeout(timer); if (readController === controller) readController = undefined; }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const navigate = (url: string): Promise<BrowserStatus> => {
    const normalized = normalizeUrl(url);
    live?.leave(); showJev(false);
    return enqueue(async () => {
      ++generation; image = undefined;
      const value = lease ? await api(endpoint('/action'), { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'navigate', url: normalized }) }) :
        await api('/api/pandacode/browser/open', { method: 'POST', headers: headers(), body: JSON.stringify({ url: normalized, taskId: options.task(), sessionId: options.session?.() }) });
      if (!lease) {
        const id = validateBrowserLease((value as { lease?: unknown })?.lease);
        if (disposed) { await closeLease(id); throw Error('Browser is closed'); }
        lease = id;
      }
      if (disposed) return status;
      status = statusValue(value); options.navigated?.(status.url); paint();
      await refreshFrame(); return status;
    });
  };
  const input = (value: Record<string, unknown>) => enqueue(async () => {
    if (!lease) throw Error('Open a page first');
    status = statusValue(await api(endpoint('/input'), { method: 'POST', headers: headers(), body: JSON.stringify(value) }));
    paint(); void refreshFrame().catch(report);
  });
  const action = (name: string) => enqueue(async () => {
    if (!lease || !actions.has(name)) throw Error('Invalid browser action');
    status = statusValue(await api(endpoint('/action'), { method: 'POST', headers: headers(), body: JSON.stringify({ action: name }) }));
    paint(); void refreshFrame().catch(report);
  });
  host.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void navigate(address.value).catch(report); });
  for (const name of actions) host.querySelector(`[data-web-browser-${name}]`)!.addEventListener('click', () => void action(name).catch(report));
  let composing = false;
  const sendText = () => {
    const text = textInput.value;
    if (!text || composing || new TextEncoder().encode(text).length > 8192) return;
    void input({ kind: 'type', text }).then(() => { if (textInput.value === text) textInput.value = ''; }).catch(report);
  };
  textInput.addEventListener('compositionstart', () => { composing = true; });
  textInput.addEventListener('compositionend', () => { composing = false; });
  textInput.addEventListener('keydown', event => { event.stopPropagation(); if (!composing && !isImeKey(event) && event.key === 'Enter') { event.preventDefault(); sendText(); } });
  host.querySelector('[data-web-browser-send]')!.addEventListener('click', sendText);
  host.querySelectorAll<HTMLButtonElement>('[data-web-browser-key]').forEach(button => button.addEventListener('click', () => void input({ kind: 'key', key: button.dataset.webBrowserKey }).catch(report)));
  frame.addEventListener('keydown', event => {
    event.stopPropagation(); if (isImeKey(event)) return;
    if (keys.has(event.key)) { event.preventDefault(); void input({ kind: 'key', key: event.key, shift: event.shiftKey }).catch(report); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void input({ kind: 'type', text: event.key }).catch(report); }
  });
  host.querySelector('[data-web-browser-pick]')!.addEventListener('click', () => { picking = !picking; paint(); });
  let suppressTouchClickUntil = 0;
  frame.addEventListener('click', event => {
    if (performance.now() < suppressTouchClickUntil) { event.preventDefault(); return; }
    const rect = frame.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const point = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    frame.focus({ preventScroll: true });
    if (!picking) { void input({ kind: 'tap', ...point }).catch(report); return; }
    const task = options.task();
    void enqueue(async () => {
      const result = await api(endpoint('/pick'), { method: 'POST', headers: headers(), body: JSON.stringify(point) }) as BrowserElement;
      if (!result || typeof result.tag !== 'string' || typeof result.html !== 'string' || typeof result.text !== 'string' || !result.bounds) throw Error('Invalid browser element');
      if (!disposed && task) options.attach(task, { ...result, id: crypto.randomUUID(), kind: 'element' });
      picking = false; paint();
    }).catch(report);
  });
  host.querySelector('[data-web-browser-inspect]')!.addEventListener('click', () => void enqueue(async () => {
    const result = await api(endpoint('/inspect'), { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'read' }) }) as { text?: unknown };
    if (!disposed) message.textContent = typeof result?.text === 'string' ? result.text.slice(0, 1200) : 'Page inspected.';
  }).catch(report));
  const flushWheel = () => {
    window.clearTimeout(wheelTimer);
    if (disposed || !lease || (!wheelX && !wheelY)) return;
    const deltaX = Math.max(-2000, Math.min(2000, wheelX)), deltaY = Math.max(-2000, Math.min(2000, wheelY));
    wheelX = wheelY = 0; void input({ kind: 'scroll', deltaX, deltaY }).catch(report);
  };
  frame.addEventListener('wheel', event => {
    event.preventDefault(); if (disposed || !lease) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1;
    wheelX = Math.max(-2000, Math.min(2000, wheelX + event.deltaX * scale)); wheelY = Math.max(-2000, Math.min(2000, wheelY + event.deltaY * scale));
    window.clearTimeout(wheelTimer); wheelTimer = window.setTimeout(flushWheel, 50);
  }, { passive: false });
  let touch: { x: number; y: number; startX: number; startY: number; dragged: boolean } | undefined;
  frame.addEventListener('touchstart', event => { const point = event.touches[0]; if (point) touch = { x: point.clientX, y: point.clientY, startX: point.clientX, startY: point.clientY, dragged: false }; }, { passive: true });
  frame.addEventListener('touchmove', event => {
    const point = event.touches[0]; if (!point || !touch) return;
    event.preventDefault(); wheelX += touch.x - point.clientX; wheelY += touch.y - point.clientY; touch.x = point.clientX; touch.y = point.clientY;
    if (Math.hypot(touch.x - touch.startX, touch.y - touch.startY) > 5) touch.dragged = true;
    window.clearTimeout(wheelTimer); wheelTimer = window.setTimeout(flushWheel, 50);
  }, { passive: false });
  frame.addEventListener('touchend', () => { if (touch?.dragged) suppressTouchClickUntil = performance.now() + 800; touch = undefined; flushWheel(); });
  frame.addEventListener('touchcancel', () => { suppressTouchClickUntil = performance.now() + 800; touch = undefined; wheelX = wheelY = 0; window.clearTimeout(wheelTimer); });
  host.querySelectorAll<HTMLButtonElement>('[data-web-browser-scroll]').forEach(button => button.addEventListener('click', () => void input({ kind: 'scroll', deltaX: 0, deltaY: Number(button.dataset.webBrowserScroll) }).catch(report)));
  host.querySelector('[data-web-browser-capture]')!.addEventListener('click', () => {
    const task = options.task();
    if (!task) return;
    void enqueue(async () => {
      // Wait for prior input and any older read, then capture a fresh frame.
      if (refreshing) await refreshing;
      await refreshFrame();
      if (!image || disposed) return;
      const captured = image, url = status.url, title = status.title;
      const bytes = Uint8Array.from(atob(captured.dataUrl.slice('data:image/png;base64,'.length)), character => character.charCodeAt(0));
      const grant = await new WebFiles().upload(new File([bytes], 'browser.png', { type: 'image/png' }), 'attachment');
      if (disposed) return;
      const imported = await call<{ id: string; width: number; height: number }>('import_prompt_image', { path: grant.grant, name: 'browser.png' });
      if (!imported || typeof imported.id !== 'string' || !imported.id || imported.id.length > 128 || imported.width !== captured.width || imported.height !== captured.height) throw Error('Invalid imported browser screenshot');
      if (!disposed) options.attach(task, { id: imported.id, name: 'browser.png', path: '', mimeType: 'image/png', url, title, width: captured.width, height: captured.height, dataUrl: captured.dataUrl, kind: 'screenshot' });
    }).catch(report);
  });
  host.querySelector('[data-web-browser-servers]')!.addEventListener('click', () => {
    void call<unknown>('list_local_servers').then(value => {
      if (!Array.isArray(value) || value.length > 128) throw Error('Invalid local server list');
      if (disposed) return;
      const list = host.querySelector('[data-web-browser-server-list]')!; list.replaceChildren();
      for (const server of value) {
        const url = normalizeUrl(server.url); const button = document.createElement('button'); button.type = 'button'; button.textContent = url;
        button.addEventListener('click', () => void navigate(url).catch(report)); list.append(button);
      }
      if (!value.length) message.textContent = 'No local servers found. Start your app in a terminal, then scan again.';
    }).catch(report);
  });
  host.querySelector('[data-web-browser-close]')!.addEventListener('click', () => options.close());
  live = await mountJevLive(liveHost, { session: () => options.session?.(), changed: active => showJev(active), returned: () => { showJev(false); address.focus(); } });
  poll = window.setInterval(() => { if (lease && !watching && !failed) void refreshFrame().catch(report); }, 1000);
  paint();
  return {
    navigate,
    watchJev: async (runId: string) => { if (disposed) throw Error('Browser is closed'); await live!.watch(runId); },
    refresh: () => { live?.refresh(); if (!watching) void refreshFrame().catch(report); },
    close: async () => {
      if (disposed) return;
      disposed = true; ++generation; window.clearInterval(poll); window.clearTimeout(wheelTimer); readController?.abort();
      void live?.close().catch(() => {}); frame.removeAttribute('src'); image = undefined; host.replaceChildren();
      const id = lease; lease = '';
      // Pending open cleans its own late lease; already-open operations settle
      // before closing so their native input cannot run after disposal.
      if (id) void queue.finally(() => closeLease(id)).catch(() => {});
    },
  };
}
