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
  // Liveness (R0301): the beat goes to the host through this document's title (native placements, no IPC) and, when
  // this shell is itself a frame of the host page (browser preview), as a message to that page. The frame answers
  // each ping; a frame that throws reports a fault. Either failure removes the frame and offers a reload.
  const embedded = typeof window !== 'undefined' && typeof parent !== 'undefined' && parent !== window;
  const tell = (kind, extra) => { if (embedded) parent.postMessage({ schemaVersion: 1, kind, sequence: beat, ...extra }, '*'); };
  let beat = 0, pending = 0, heart = 0;
  const stop = () => { if (heart && typeof clearInterval === 'function') clearInterval(heart); heart = 0; };
  const fail = reason => {
    if (!alive) return;
    alive = false; controller.abort(); clearTimeout(timeout); stop(); frame.remove();
    document.title = `panda-view:failed:${reason}`;
    status.textContent = reason === 'unresponsive' ? 'The extension panel stopped responding. The rest of PandaCode is unaffected.' : 'The extension panel failed. The rest of PandaCode is unaffected.';
    const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Reload panel';
    reload.addEventListener('click', () => location.reload(), { once: true });
    document.body.append(reload);
    tell('failed', { reason });
  };
  const timeout = setTimeout(() => { alive = false; controller.abort(); stop(); frame.remove(); document.title = 'panda-view:failed:timeout'; tell('failed', { reason: 'timeout' }); status.textContent = 'Extension content did not initialize. Close this window and use the built-in view.'; }, 5000);
  if (typeof setInterval === 'function') heart = setInterval(() => {
    if (!alive) return;
    beat++; document.title = `panda-view:alive:${beat}`; tell('beat');
    if (!initialized) return;
    if (pending && beat - pending > 3) { fail('unresponsive'); return; }
    if (!pending) { pending = beat; frame.contentWindow.postMessage({ schemaVersion: 1, session: config.session, kind: 'ping', sequence: beat }, '*'); }
  }, 1000);
  addEventListener('message', event => {
    if (!alive || event.source !== frame.contentWindow || event.origin !== 'null') return;
    if (richViewSignal(event.data, config.session, 'fault')) { fail('error'); return; }
    if (initialized) { if (richViewSignal(event.data, config.session, 'pong') && event.data.sequence === pending) pending = 0; return; }
    if (!richViewMessage(event.data, config.session, 'ready', 1)) return;
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
  addEventListener('pagehide', () => { alive = false; controller.abort(); clearTimeout(timeout); stop(); frame.remove(); }, { once: true });
  frame.srcdoc = config.document;
  document.body.replaceChildren(status, frame);
})();
