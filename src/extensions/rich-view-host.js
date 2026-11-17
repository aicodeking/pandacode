(() => {
  'use strict';
  const config = JSON.parse(document.getElementById('panda-view-config').textContent);
  // R0302: a served panel (`config.src`: a folder entry or a remote page) is framed from the package's own origin,
  // unsandboxed, so its page keeps that origin and its own storage. The legacy inline form stays an opaque frame.
  const served = typeof config.src === 'string';
  const frame = document.createElement('iframe');
  frame.title = 'Isolated extension content';
  if (!served) frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('width', '100%'); frame.setAttribute('height', '90%'); frame.setAttribute('frameborder', '0');
  let alive = true, initialized = false;
  let sequence = 1;
  const controller = new AbortController();
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Loading isolated extension content…';
  // Liveness (R0301): the beat goes to the host through this document's title (native placements, no IPC) and, when
  // this shell is itself a frame of the host page (browser preview), as a message to that page. The frame answers
  // each ping; a frame that throws reports a fault. Either failure removes the frame and offers a reload.
  // A served folder page shares this shell's origin and event loop, so a page that loops stops the beat itself and
  // the host watchdog ends it; served frames are not pinged.
  const embedded = typeof window !== 'undefined' && typeof parent !== 'undefined' && parent !== window;
  const tell = (kind, extra) => { if (embedded) parent.postMessage({ schemaVersion: 1, kind, sequence: beat, ...extra }, '*'); };
  let beat = 0, pending = 0, heart = 0;
  const stop = () => { if (heart && typeof clearInterval === 'function') clearInterval(heart); heart = 0; };
  const failures = {
    unresponsive: 'The extension panel stopped responding. The rest of PandaCode is unaffected.',
    origin: 'The extension panel tried to open an address its package does not declare in rich.remote, and was stopped. The rest of PandaCode is unaffected.',
  };
  const fail = (reason, detail) => {
    if (!alive) return;
    alive = false; controller.abort(); clearTimeout(timeout); stop(); frame.remove();
    document.title = `panda-view:failed:${reason}`;
    status.textContent = `${failures[reason] || 'The extension panel failed. The rest of PandaCode is unaffected.'}${detail ? ` (${detail})` : ''}`;
    const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Reload panel';
    reload.addEventListener('click', () => location.reload(), { once: true });
    document.body.append(reload);
    tell('failed', { reason });
  };
  const expire = () => { alive = false; controller.abort(); stop(); frame.remove(); document.title = 'panda-view:failed:timeout'; tell('failed', { reason: 'timeout' }); status.textContent = 'Extension content did not initialize. Close this window and use the built-in view.'; };
  // A served page without the client (a remote page that does not include it) is shown and has no channel.
  const timeout = !served ? setTimeout(expire, 5000) : config.expectsClient ? setTimeout(expire, 10000) : 0;
  if (typeof setInterval === 'function') heart = setInterval(() => {
    if (!alive) return;
    beat++; document.title = `panda-view:alive:${beat}`; tell('beat');
    if (!initialized || served) return;
    if (pending && beat - pending > 3) { fail('unresponsive'); return; }
    if (!pending) { pending = beat; frame.contentWindow.postMessage({ schemaVersion: 1, session: config.session, kind: 'ping', sequence: beat }, '*'); }
  }, 1000);
  const origins = served ? [location.origin, ...(Array.isArray(config.frameOrigins) ? config.frameOrigins : [])] : ['null'];
  addEventListener('message', event => {
    if (!alive || event.source !== frame.contentWindow || !origins.includes(event.origin)) return;
    if (richViewSignal(event.data, config.session, 'fault')) { fail('error'); return; }
    // A served frame may load another page of its folder: each new document announces itself and is initialized.
    if (initialized && !served) { if (richViewSignal(event.data, config.session, 'pong') && event.data.sequence === pending) pending = 0; return; }
    if (!richViewMessage(event.data, config.session, 'ready', 1)) return;
    const message = { schemaVersion: 1, session: config.session, kind: 'init', sequence: 1, dto: config.dto, theme: config.theme };
    if (!richViewMessage(message, config.session, 'init', 1)) return;
    initialized = true; sequence = 1; clearTimeout(timeout); status.textContent = 'Isolated extension view';
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
  if (!served) {
    frame.srcdoc = config.document;
    document.body.replaceChildren(status, frame);
    return;
  }
  // This shell's policy pins its frame to the package origin and rich.remote: a frame that navigates elsewhere is a
  // violation of that policy, and the panel is shown as failed with a reload control.
  document.addEventListener('securitypolicyviolation', event => {
    if (`${event.effectiveDirective || event.violatedDirective}`.startsWith('frame-src')) {
      let blocked = '';
      try { blocked = new URL(event.blockedURI).origin; } catch { blocked = String(event.blockedURI || '').slice(0, 120); }
      fail('origin', blocked);
    }
  }, { signal: controller.signal });
  // A remote page without the client never initializes: once it has loaded it is shown as is.
  frame.addEventListener('load', () => { if (alive && !initialized && !config.expectsClient) status.textContent = 'Isolated extension view'; }, { signal: controller.signal });
  const start = () => { if (!alive) return; frame.src = config.src; document.body.replaceChildren(status, frame); };
  if (!config.wipe) { start(); return; }
  // "Remove own data" (R0302): clear this origin's page storage once, before the package's page runs.
  status.textContent = 'Clearing the panel’s removed data…';
  document.body.replaceChildren(status);
  const quietly = run => { try { return Promise.resolve(run()).catch(() => {}); } catch { return Promise.resolve(); } };
  Promise.all([
    quietly(() => { localStorage.clear(); sessionStorage.clear(); }),
    quietly(async () => { for (const database of (await indexedDB.databases?.()) || []) if (database.name) indexedDB.deleteDatabase(database.name); }),
    quietly(async () => { if (typeof caches !== 'undefined') for (const name of await caches.keys()) await caches.delete(name); }),
  ]).then(() => quietly(() => fetch(`/~panda/wiped`, { cache: 'no-store' }))).then(start);
})();
