(() => {
  'use strict';
  const session = JSON.parse(document.getElementById('panda-view-session').textContent);
  let initialized = false, alive = true;
  const callbacks = new Set();
  let current;
  const listener = event => {
    if (!alive || initialized || event.source !== parent || !richViewMessage(event.data, session, 'init', 1)) return;
    initialized = true;
    current = Object.freeze({ dto: Object.freeze(event.data.dto), theme: Object.freeze(event.data.theme) });
    document.documentElement.dataset.colorScheme = current.theme.colorScheme;
    callbacks.forEach(callback => { try { callback(current); } catch { /* Package failure cannot break channel disposal. */ } });
  };
  addEventListener('message', listener);
  addEventListener('pagehide', () => { alive = false; removeEventListener('message', listener); callbacks.clear(); current = undefined; }, { once: true });
  Object.defineProperty(window, 'pandaView', { value: Object.freeze({
    onDidInitialize(callback) {
      if (!alive || typeof callback !== 'function' || callbacks.size >= 16) return () => {};
      callbacks.add(callback);
      if (current) callback(current);
      return () => callbacks.delete(callback);
    }
  }) });
  parent.postMessage({ schemaVersion: 1, session, kind: 'ready', sequence: 1 }, '*');
})();
