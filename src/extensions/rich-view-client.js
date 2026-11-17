(() => {
  'use strict';
  if ('pandaView' in window) return;
  // The legacy inline document carries its session in an element; a served folder page (R0302) gets this script as
  // `/~panda/client.js` with the session on the tag, and learns its base address from it (`pandaView.baseUrl`).
  // A remote page includes the SDK's copy of this script (`sdk/panda-view.js`) with `data-panda-session` from its URL.
  const inline = document.getElementById('panda-view-session');
  const tag = !inline && document.currentScript ? document.currentScript : null;
  const fragment = () => { try { return new URLSearchParams(String(location.hash || '').slice(1)).get('panda-session') || ''; } catch { return ''; } };
  const session = inline ? JSON.parse(inline.textContent) : (tag && tag.dataset.pandaSession) || fragment();
  const baseUrl = tag && tag.src ? new URL('/', tag.src).href : undefined;
  let initialized = false, alive = true;
  const callbacks = new Set();
  let current;
  let sequence = 0;
  const themeCallbacks = new Set();
  // R0303: the instance, its state, the channel to the service and the proxied SDK. Only an init that carries an
  // instance opens the channel (a served panel); the inline form stays presentation only.
  let instance = null, state, visibility, nextId = 0;
  const messageCallbacks = new Set(), visibilityCallbacks = new Set(), waiting = new Map();
  const failure = text => { const error = new Error(text); error.code = String(text).split(':')[0]; return error; };
  const safely = (callback, value) => { try { callback(value); } catch { /* Package failure cannot break channel disposal. */ } };
  const send = (kind, fields) => parent.postMessage({ schemaVersion: 1, session, kind, ...fields }, '*');
  const NO_CHANNEL = 'UnsupportedCapability: this panel has no channel (the inline rich form, or before initialization). Declare rich.folder to talk to the service.';
  const request = (kind, fields) => new Promise((resolve, reject) => {
    if (!alive) { reject(failure('StaleContext: the panel document is closed.')); return; }
    if (!instance) { reject(failure(NO_CHANNEL)); return; }
    if (waiting.size >= 64) { reject(failure('LimitExceeded: 64 panel requests are waiting for answers. Wait for some before sending more.')); return; }
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    send(kind, { id, ...fields });
  });
  // R0301: answer the shell's liveness ping, and report the package's first uncaught error once (the shell then shows
  // the panel as failed with a reload control; nothing else in the app is touched).
  let faulted = false;
  const fault = () => { if (!alive || faulted) return; faulted = true; parent.postMessage({ schemaVersion: 1, session, kind: 'fault', sequence: 1 }, '*'); };
  addEventListener('error', fault);
  addEventListener('unhandledrejection', fault);
  const listener = event => {
    if (!alive || event.source !== parent) return;
    if (richViewSignal(event.data, session, 'ping')) { parent.postMessage({ schemaVersion: 1, session, kind: 'pong', sequence: event.data.sequence }, '*'); return; }
    const data = event.data;
    if (initialized && instance && data && typeof data === 'object') {
      if (richViewChannel(data, session, 'message')) { messageCallbacks.forEach(callback => safely(callback, data.message)); return; }
      if (richViewChannel(data, session, 'reply')) {
        const waiter = waiting.get(data.id);
        if (!waiter) return;
        waiting.delete(data.id);
        if (data.ok) waiter.resolve(data.value === undefined ? null : data.value);
        else waiter.reject(failure(typeof data.error.message === 'string' ? data.error.message : data.error.code));
        return;
      }
      if (richViewChannel(data, session, 'visibility') && typeof data.focused === 'boolean') {
        visibility = Object.freeze({ visible: data.visible, focused: data.focused });
        visibilityCallbacks.forEach(callback => safely(callback, visibility));
        return;
      }
    }
    const kind = initialized ? 'theme' : 'init';
    if (!richViewMessage(data, session, kind, sequence + 1)) return;
    sequence++;
    initialized = true;
    if (data.theme.tokens) Object.freeze(data.theme.tokens);
    if (kind === 'init' && data.instance) {
      instance = Object.freeze({ instanceId: data.instance.instanceId, viewId: data.instance.viewId, placement: data.instance.placement, restored: data.instance.restored });
      state = data.instance.state;
    }
    current = Object.freeze({ dto: Object.freeze(data.dto), theme: Object.freeze(data.theme), ...(instance ? { ...instance, state } : {}) });
    document.documentElement.dataset.colorScheme = current.theme.colorScheme;
    (kind === 'init' ? callbacks : themeCallbacks).forEach(callback => safely(callback, kind === 'init' ? current : current.theme));
  };
  addEventListener('message', listener);
  // R0304: the key-downs this page left alone (Escape, command chords; never an input-method composition) go to the
  // host through the shell. Read after the event's dispatch, so a page that handles a key (preventDefault) keeps it.
  const mac = typeof navigator !== 'undefined' && richViewMac(navigator);
  const later = typeof setTimeout === 'function' ? run => setTimeout(run, 0) : run => run();
  const onKey = event => { if (alive) later(() => { const chord = alive ? richViewChord(event, mac) : null; if (chord) send('key', chord); }); };
  addEventListener('keydown', onKey);
  addEventListener('pagehide', () => {
    alive = false; removeEventListener('message', listener); removeEventListener('error', fault); removeEventListener('unhandledrejection', fault); removeEventListener('keydown', onKey);
    callbacks.clear(); themeCallbacks.clear(); messageCallbacks.clear(); visibilityCallbacks.clear(); current = undefined;
    for (const waiter of waiting.values()) waiter.reject(failure('StaleContext: the panel document is closed.'));
    waiting.clear();
  }, { once: true });
  const subscribe = (set, callback, now) => {
    if (!alive || typeof callback !== 'function' || set.size >= 16) return () => {};
    set.add(callback);
    if (now !== undefined) safely(callback, now);
    return () => set.delete(callback);
  };
  // `pandaView.panda`: the package SDK through the host, by path (`tasks.queue.list`). Service-only calls answer
  // UnsupportedCapability here and again in the host: secrets never reach a webview and a handler must outlive a panel.
  const node = path => new Proxy(function () {}, {
    get: (_, key) => (typeof key !== 'string' || key === 'then' || path.split('.').length >= 3) ? undefined : node(path ? `${path}.${key}` : key),
    apply: (_, __, args) => {
      if (richViewServiceOnly(path)) return Promise.reject(failure(`UnsupportedCapability: ${path} is a service-only call. Secrets, sign-in, the data directory, internal calls and handler registrations stay in the package's service.`));
      if (!/^[A-Za-z]+(\.[A-Za-z]+){1,2}$/.test(path) || args.length > 4) return Promise.reject(failure(`NotFound: ${path || 'panda'} is not a call of the package SDK.`));
      const size = richViewBytes(args);
      if (size > RICH_VIEW_LIMIT) return Promise.reject(failure(`LimitExceeded: a panel call is at most 256 KiB of JSON (this one is ${size} bytes).`));
      return request('call', { path, args: JSON.parse(JSON.stringify(args)) });
    },
  });
  Object.defineProperty(window, 'pandaView', { value: Object.freeze({
    ...(baseUrl ? { baseUrl } : {}),
    get viewId() { return instance ? instance.viewId : current ? current.dto.viewId : ''; },
    get instanceId() { return instance ? instance.instanceId : ''; },
    onDidChangeTheme(callback) { return subscribe(themeCallbacks, callback); },
    onDidInitialize(callback) { return subscribe(callbacks, callback, current); },
    onMessage(callback) { return subscribe(messageCallbacks, callback); },
    // Called once after initialization and at every change: a hidden frame may never fire the page's own event.
    onDidChangeVisibility(callback) { return subscribe(visibilityCallbacks, callback, visibility); },
    postMessage(message) {
      if (!instance) return Promise.reject(failure(NO_CHANNEL));
      const size = richViewBytes(message);
      if (size === Infinity) return Promise.reject(failure('InvalidShape: a panel message is JSON.'));
      if (size > RICH_VIEW_LIMIT) return Promise.reject(failure(`LimitExceeded: a panel message is at most 256 KiB of JSON (this one is ${size} bytes). Send larger data in chunks.`));
      return request('post', { message: JSON.parse(JSON.stringify(message)) });
    },
    // Synchronous for the page; handed to the host in the same task. It survives hiding, a reload and a failure of
    // the panel for one run of the app (durable data: storage.private or the page's own storage).
    state: Object.freeze({
      get() { return state; },
      set(value) {
        const size = richViewBytes(value);
        if (size === Infinity) throw failure('InvalidShape: pandaView.state holds JSON.');
        if (size > RICH_VIEW_LIMIT) throw failure(`LimitExceeded: pandaView.state is at most 256 KiB of JSON (this one is ${size} bytes). Keep larger data in the page's own storage or storage.private.`);
        state = JSON.parse(JSON.stringify(value));
        if (instance && alive) send('state', { value: state });
      },
    }),
    // R0304: gives the keyboard back to the app control that had it before this panel (the same as Escape).
    releaseFocus() {
      if (!alive) return;
      const active = typeof document.activeElement === 'object' ? document.activeElement : null;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
      send('release', {});
    },
    panda: node(''),
  }) });
  parent.postMessage({ schemaVersion: 1, session, kind: 'ready', sequence: 1 }, '*');
})();
