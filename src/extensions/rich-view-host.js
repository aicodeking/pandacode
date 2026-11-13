(() => {
  'use strict';
  const config = JSON.parse(document.getElementById('panda-view-config').textContent);
  const frame = document.createElement('iframe');
  frame.title = 'Isolated extension content';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('width', '100%'); frame.setAttribute('height', '90%'); frame.setAttribute('frameborder', '0');
  let alive = true, initialized = false;
  let sequence = 1;
  const controller = new AbortController();
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Loading isolated extension content…';
  const timeout = setTimeout(() => { alive = false; controller.abort(); frame.remove(); status.textContent = 'Extension content did not initialize. Close this window and use the built-in view.'; }, 5000);
  addEventListener('message', event => {
    if (!alive || initialized || event.source !== frame.contentWindow || event.origin !== 'null' || !richViewMessage(event.data, config.session, 'ready', 1)) return;
    const message = { schemaVersion: 1, session: config.session, kind: 'init', sequence: 1, dto: config.dto, theme: config.theme };
    if (!richViewMessage(message, config.session, 'init', 1)) return;
    initialized = true; clearTimeout(timeout); status.textContent = 'Isolated extension view';
    frame.contentWindow.postMessage(message, '*');
  }, { signal: controller.signal });
  addEventListener('panda-view-theme', event => {
    if (!alive || !initialized) return;
    const message = { schemaVersion: 1, session: config.session, kind: 'theme', sequence: sequence + 1, dto: config.dto, theme: event.detail };
    if (!richViewMessage(message, config.session, 'theme', sequence + 1)) return;
    sequence++; frame.contentWindow.postMessage(message, '*');
  }, { signal: controller.signal });
  // Source-window identity is checked, not a payload's claimed window/owner. A navigation
  // destroys this document/session; no package message ever becomes a native command.
  addEventListener('pagehide', () => { alive = false; controller.abort(); clearTimeout(timeout); frame.remove(); }, { once: true });
  frame.srcdoc = config.document;
  document.body.replaceChildren(status, frame);
})();
