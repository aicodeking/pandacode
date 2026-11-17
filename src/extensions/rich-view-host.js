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
  // R0303: the channel of a served panel. Installed: `POST /~panda/channel` on this origin (the host knows the
  // webview; nothing in the body names it) and pushes dispatched as `panda-view-host` events. Preview (an embedded
  // shell): the same requests and pushes through the host page. The inline form has none (its document pins
  // connect-src 'none').
  const transport = !served ? null : embedded ? 'embedded' : 'native';
  let channelOpen = false, hostVisible = true, sentVisibility = '', focused = false, seq = 0;
  const replies = new Map(), held = [];
  const unavailable = { ok: false, error: { schemaVersion: 1, code: 'HostUnavailable', message: 'HostUnavailable: the panel host did not answer. Reload the panel.', path: '$', ids: [] } };
  const toHost = (kind, fields) => {
    const body = { schemaVersion: 1, session: config.session, kind, ...fields };
    if (transport === 'native') {
      return fetch('/~panda/channel', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, cache: 'no-store', keepalive: kind === 'bye' })
        .then(response => response.json()).catch(() => unavailable);
    }
    if (transport === 'embedded') return new Promise(resolve => { const id = ++seq; replies.set(id, resolve); parent.postMessage({ schemaVersion: 1, kind: 'channel', seq: id, request: body }, '*'); });
    return Promise.resolve({ ok: false, error: { schemaVersion: 1, code: 'UnsupportedCapability', message: 'UnsupportedCapability: the inline rich form has no channel. Declare rich.folder to talk to the service.', path: '$', ids: [] } });
  };
  const toFrame = message => { if (alive && frame.contentWindow) frame.contentWindow.postMessage(message, '*'); };
  const refuse = (id, error) => toFrame({ schemaVersion: 1, session: config.session, kind: 'reply', id, ok: false, error });
  // What the page sees: the host's visibility and this document's focus (a focused frame is part of it).
  const showVisibility = () => {
    if (!alive || !initialized || !channelOpen) return;
    const now = typeof document.hasFocus === 'function' && document.hasFocus();
    if (now !== focused) { focused = now; void toHost('focus', { focused }); }
    const key = `${hostVisible}:${focused}`;
    if (key === sentVisibility) return;
    sentVisibility = key;
    toFrame({ schemaVersion: 1, session: config.session, kind: 'visibility', visible: hostVisible, focused });
  };
  const sendTheme = theme => {
    if (!alive || !initialized) return;
    const message = { schemaVersion: 1, session: config.session, kind: 'theme', sequence: sequence + 1, dto: config.dto, theme };
    if (!richViewMessage(message, config.session, 'theme', sequence + 1)) return;
    sequence++; toFrame(message);
  };
  const fromHost = detail => {
    if (!alive || !detail || typeof detail !== 'object' || detail.session !== config.session) return;
    if (!initialized || !channelOpen) { if (held.length < 64) held.push(detail); return; }
    if (richViewChannel(detail, config.session, 'message') || richViewChannel(detail, config.session, 'reply')) toFrame(detail);
    else if (richViewChannel(detail, config.session, 'visibility')) { hostVisible = detail.visible; showVisibility(); }
    else if (richViewChannel(detail, config.session, 'theme')) sendTheme(detail.theme);
  };
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
    showVisibility();
    if (!initialized || served) return;
    if (pending && beat - pending > 3) { fail('unresponsive'); return; }
    if (!pending) { pending = beat; frame.contentWindow.postMessage({ schemaVersion: 1, session: config.session, kind: 'ping', sequence: beat }, '*'); }
  }, 1000);
  const origins = served ? [location.origin, ...(Array.isArray(config.frameOrigins) ? config.frameOrigins : [])] : ['null'];
  // R0304: keys the page left alone and releaseFocus go to the host: the host page of an embedded shell, the channel
  // of a served shell, else this document's title (the inline form has no channel). The title sequence only grows.
  let focusSequence = Date.now();
  const mac = typeof navigator !== 'undefined' && richViewMac(navigator);
  const forward = (kind, chord) => {
    if (!alive) return;
    if (embedded) { tell(kind, kind === 'key' ? { chord } : {}); return; }
    if (transport === 'native') { void toHost(kind, kind === 'key' ? chord : {}); return; }
    focusSequence++;
    const flags = chord ? (chord.ctrlKey ? 1 : 0) | (chord.metaKey ? 2 : 0) | (chord.shiftKey ? 4 : 0) | (chord.altKey ? 8 : 0) : 0;
    document.title = kind === 'key' ? `panda-view:key:${focusSequence}:${flags}:${chord.code}:${chord.key}` : `panda-view:release:${focusSequence}`;
  };
  // The shell's own document (its status line or reload control) follows the same rule.
  addEventListener('keydown', event => { setTimeout(() => { const chord = alive ? richViewChord(event, mac) : null; if (chord) forward('key', chord); }, 0); }, { signal: controller.signal });
  // The keyboard arriving at the shell (the host's tab stop gave the webview focus) goes on to the panel's frame.
  addEventListener('focus', () => { if (alive && frame.isConnected && document.activeElement === document.body) frame.focus(); }, { signal: controller.signal });
  // R0304: rich.minSize from the host's address (`#panda-min=<w>x<h>`): the frame keeps that minimum and this document
  // scrolls, so a smaller mount scrolls and the page is never scaled.
  const minimum = /(?:^#|&)panda-min=(\d{2,4})x(\d{2,4})(?:&|$)/.exec(String(location.hash || ''));
  if (minimum) { frame.style.minWidth = `${minimum[1]}px`; frame.style.minHeight = `${minimum[2]}px`; frame.style.display = 'block'; document.documentElement.style.overflow = 'auto'; }
  // The host page of an embedded shell answers its channel requests and pushes; nothing else from it is heard.
  if (transport === 'embedded') addEventListener('message', event => {
    const data = event.data;
    if (!alive || event.source !== parent || !data || typeof data !== 'object' || data.schemaVersion !== 1) return;
    if (data.kind === 'channel-reply' && replies.has(data.seq)) { const resolve = replies.get(data.seq); replies.delete(data.seq); resolve(data.response && typeof data.response === 'object' ? data.response : unavailable); }
    else if (data.kind === 'host') fromHost(data.detail);
  }, { signal: controller.signal });
  if (transport === 'native') addEventListener('panda-view-host', event => fromHost(event.detail), { signal: controller.signal });
  // Initializes the frame's document. A served page first asks the host for its instance (`hello`): the init then
  // carries the instance, its state and the current theme, followed by its visibility and what waited for it.
  let starting = false;
  const initialize = () => {
    const init = (instance, theme) => {
      const message = { schemaVersion: 1, session: config.session, kind: 'init', sequence: 1, dto: config.dto, theme: theme || config.theme, ...(instance ? { instance } : {}) };
      if (!richViewMessage(message, config.session, 'init', 1)) return false;
      initialized = true; sequence = 1; clearTimeout(timeout); status.textContent = 'Isolated extension view';
      toFrame(message);
      return true;
    };
    if (!transport) { init(); return; }
    if (starting) return;
    starting = true;
    void toHost('hello', {}).then(response => {
      starting = false;
      if (!alive) return;
      const value = response && response.ok ? response.value : null;
      const instance = value && { instanceId: value.instanceId, viewId: value.viewId, placement: value.placement, restored: value.restored, ...(value.state !== undefined ? { state: value.state } : {}) };
      const theme = value && richViewTheme(value.theme) ? value.theme : undefined;
      if (!init(instance && richViewInstance(instance) ? instance : undefined, theme)) { init(); return; }
      channelOpen = !!instance;
      if (!channelOpen) return;
      hostVisible = value.visible !== false; sentVisibility = '';
      showVisibility();
      for (const message of Array.isArray(value.pending) ? value.pending : []) fromHost({ ...message, schemaVersion: 1, session: config.session });
      for (const detail of held.splice(0)) fromHost(detail);
    });
  };
  addEventListener('message', event => {
    if (!alive || event.source !== frame.contentWindow || !origins.includes(event.origin)) return;
    if (richViewSignal(event.data, config.session, 'fault')) { fail('error'); return; }
    // R0304: a key-down the page left alone, or releaseFocus, from the frame's client (any time it is alive).
    if (richViewChannel(event.data, config.session, 'key')) { const { key, code, ctrlKey, metaKey, shiftKey, altKey } = event.data; forward('key', { key, code, ctrlKey, metaKey, shiftKey, altKey }); return; }
    if (richViewChannel(event.data, config.session, 'release')) { forward('release'); return; }
    // The frame's channel requests after the handshake go to the host as they are, never as anything else.
    if (initialized && served) {
      const data = event.data;
      if (richViewChannel(data, config.session, 'post') || richViewChannel(data, config.session, 'call')) {
        if (!channelOpen) { refuse(data.id, { schemaVersion: 1, code: 'UnsupportedCapability', message: 'UnsupportedCapability: this panel has no channel.' }); return; }
        const fields = data.kind === 'post' ? { id: data.id, message: data.message } : { id: data.id, path: data.path, args: data.args };
        void toHost(data.kind, fields).then(response => { if (!response || response.ok !== true) refuse(data.id, (response && response.error) || unavailable.error); });
        return;
      }
      if (richViewChannel(data, config.session, 'state')) { if (channelOpen) void toHost('state', { value: data.value }); return; }
    }
    // A served frame may load another page of its folder: each new document announces itself and is initialized.
    if (initialized && !served) { if (richViewSignal(event.data, config.session, 'pong') && event.data.sequence === pending) pending = 0; return; }
    if (!richViewMessage(event.data, config.session, 'ready', 1)) return;
    initialize();
  }, { signal: controller.signal });
  // The preview's separate window and the legacy host follow the app's appearance through this event.
  addEventListener('panda-view-theme', event => sendTheme(event.detail), { signal: controller.signal });
  if (typeof document.hasFocus === 'function') for (const name of ['focus', 'blur']) addEventListener(name, () => setTimeout(showVisibility, 0), { signal: controller.signal });
  // Source-window identity is checked, not a payload's claimed window/owner. A navigation
  // destroys this document/session; no package message ever becomes a native command.
  addEventListener('pagehide', () => {
    if (channelOpen) void toHost('bye', {});
    alive = false; controller.abort(); clearTimeout(timeout); stop(); frame.remove();
  }, { once: true });
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
  // R0303: a remote page learns its session from the fragment (never sent to its server), so a page that includes the
  // client script (`sdk/panda-view.js`) gets the channel; a page without it is shown as is.
  const address = config.src.startsWith('/') ? config.src : `${config.src.split('#')[0]}#panda-session=${encodeURIComponent(config.session)}`;
  const start = () => { if (!alive) return; frame.src = address; document.body.replaceChildren(status, frame); };
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
