(() => {
  'use strict';
  const session = JSON.parse(document.getElementById('panda-view-session').textContent);
  let initialized = false, alive = true;
  const callbacks = new Set();
  let current;
  let sequence = 0;
  const themeCallbacks = new Set();
  const listener = event => {
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
  addEventListener('pagehide', () => { alive = false; removeEventListener('message', listener); callbacks.clear(); themeCallbacks.clear(); current = undefined; }, { once: true });
  Object.defineProperty(window, 'pandaView', { value: Object.freeze({
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
