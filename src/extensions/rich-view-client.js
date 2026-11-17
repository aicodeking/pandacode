(() => {
  'use strict';
  if ('pandaView' in window) return;
  // The legacy inline document carries its session in an element; a served folder page (R0302) gets this script as
  // `/~panda/client.js` with the session on the tag, and learns its base address from it (`pandaView.baseUrl`).
  const inline = document.getElementById('panda-view-session');
  const tag = !inline && document.currentScript ? document.currentScript : null;
  const session = inline ? JSON.parse(inline.textContent) : (tag && tag.dataset.pandaSession) || '';
  const baseUrl = tag && tag.src ? new URL('/', tag.src).href : undefined;
  let initialized = false, alive = true;
  const callbacks = new Set();
  let current;
  let sequence = 0;
  const themeCallbacks = new Set();
  // R0301: answer the shell's liveness ping, and report the package's first uncaught error once (the shell then shows
  // the panel as failed with a reload control; nothing else in the app is touched).
  let faulted = false;
  const fault = () => { if (!alive || faulted) return; faulted = true; parent.postMessage({ schemaVersion: 1, session, kind: 'fault', sequence: 1 }, '*'); };
  addEventListener('error', fault);
  addEventListener('unhandledrejection', fault);
  const listener = event => {
    if (alive && event.source === parent && richViewSignal(event.data, session, 'ping')) { parent.postMessage({ schemaVersion: 1, session, kind: 'pong', sequence: event.data.sequence }, '*'); return; }
    const kind = initialized ? 'theme' : 'init';
    if (!alive || event.source !== parent || !richViewMessage(event.data, session, kind, sequence + 1)) return;
    sequence++;
    initialized = true;
    if (event.data.theme.tokens) Object.freeze(event.data.theme.tokens);
    current = Object.freeze({ dto: Object.freeze(event.data.dto), theme: Object.freeze(event.data.theme) });
    document.documentElement.dataset.colorScheme = current.theme.colorScheme;
    (kind === 'init' ? callbacks : themeCallbacks).forEach(callback => { try { callback(kind === 'init' ? current : current.theme); } catch { /* Package failure cannot break channel disposal. */ } });
  };
  addEventListener('message', listener);
  addEventListener('pagehide', () => { alive = false; removeEventListener('message', listener); removeEventListener('error', fault); removeEventListener('unhandledrejection', fault); callbacks.clear(); themeCallbacks.clear(); current = undefined; }, { once: true });
  Object.defineProperty(window, 'pandaView', { value: Object.freeze({
    ...(baseUrl ? { baseUrl } : {}),
    onDidChangeTheme(callback) {
      if (!alive || typeof callback !== 'function' || themeCallbacks.size >= 16) return () => {};
      themeCallbacks.add(callback); return () => themeCallbacks.delete(callback);
    },
    onDidInitialize(callback) {
      if (!alive || typeof callback !== 'function' || callbacks.size >= 16) return () => {};
      callbacks.add(callback);
      if (current) callback(current);
      return () => callbacks.delete(callback);
    }
  }) });
  parent.postMessage({ schemaVersion: 1, session, kind: 'ready', sequence: 1 }, '*');
})();
