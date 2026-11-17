// Work board (sample.live-board), cut A: the installed service.
//
// The board's own logic is lib/board.mjs, one browser-safe module that the browser preview runs as well. This file is
// only the transport: a small client of the tracker daemon (newline-delimited JSON over TCP) with reconnect and
// backoff. The address comes from the Tracker settings page; PANDA_FIXTURE_B1 is the address a test hands in before
// the settings are read.
const net = require('node:net');

const TIMEOUT_MS = 1500;
const BACKOFF_MS = [250, 500, 1000];
const fail = code => Object.assign(new Error(code), { code });
const topicOf = event => (event === 'signal' ? 'signals' : String(event).split('.')[0]);

function tcpLink(initialAddress) {
  let address = initialAddress;
  let socket = null, up = false, closed = false, connecting = null, timer = null, attempt = 0, sequence = 0, buffer = '';
  const pending = new Map();
  const topics = new Map();
  const downs = new Set(), ups = new Set();

  const send = (op, params) => new Promise((resolve, reject) => {
    if (!up || !socket) { reject(fail('Unreachable')); return; }
    const id = ++sequence;
    const guard = setTimeout(() => { pending.delete(id); reject(fail('Timeout')); socket?.destroy(); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, guard });
    socket.write(`${JSON.stringify({ id, op, params: params ?? {} })}\n`);
  });

  const receive = (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id !== undefined) {
        const entry = pending.get(frame.id);
        if (!entry) continue;
        pending.delete(frame.id); clearTimeout(entry.guard);
        if (frame.ok) entry.resolve(frame.result); else entry.reject(fail(frame.error?.code ?? 'Failed'));
      } else if (typeof frame.event === 'string') {
        for (const handler of [...(topics.get(topicOf(frame.event)) ?? [])]) { try { handler(frame); } catch { /* a handler never stops the stream */ } }
      }
    }
  };

  const lost = ended => {
    if (ended !== socket) return;
    socket = null; up = false; buffer = '';
    for (const [id, entry] of pending) { clearTimeout(entry.guard); entry.reject(fail('Unreachable')); pending.delete(id); }
    if (closed) return;
    for (const handler of [...downs]) { try { handler(); } catch { /* ignored */ } }
    reconnectLater();
  };

  const handshake = async () => {
    await send('hello', { client: 'sample.live-board' });
    for (const topic of topics.keys()) await send('subscribe', { topic });
  };

  const open = () => {
    if (up) return Promise.resolve();
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const [host, port] = String(address || '').split(':');
      if (!host || !Number(port)) { reject(fail('Unreachable')); return; }
      const next = net.connect({ host, port: Number(port) });
      let opened = false;
      next.setEncoding('utf8');
      next.on('error', () => {});
      next.on('data', receive);
      next.once('connect', () => { opened = true; socket = next; up = true; buffer = ''; resolve(); });
      next.on('close', () => { if (opened) lost(next); else reject(fail('Unreachable')); });
    }).then(handshake).then(() => { attempt = 0; for (const handler of [...ups]) { try { handler(); } catch { /* ignored */ } } })
      .catch(error => { socket?.destroy(); throw error; })
      .finally(() => { connecting = null; });
    return connecting;
  };

  function reconnectLater() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      open().catch(() => reconnectLater());
    }, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
  }

  return {
    async request(op, params) {
      try { await open(); } catch (error) { reconnectLater(); throw error; }
      return send(op, params);
    },
    async subscribe(topic, handler) {
      let set = topics.get(topic);
      if (!set) { set = new Set(); topics.set(topic, set); }
      set.add(handler);
      // Not connected yet: the handshake of the next connection subscribes every registered topic.
      if (up) { try { await send('subscribe', { topic }); } catch { /* the next handshake does it */ } } else reconnectLater();
      return { dispose: () => { set.delete(handler); } };
    },
    onDown(handler) { downs.add(handler); return { dispose: () => { downs.delete(handler); } }; },
    onUp(handler) { ups.add(handler); return { dispose: () => { ups.delete(handler); } }; },
    async reconnect() {
      clearTimeout(timer); timer = null; attempt = 0;
      try { await open(); } catch (error) { reconnectLater(); throw error; }
    },
    async retarget(next) {
      if (next === address) return;
      address = next;
      if (socket) socket.destroy(); else reconnectLater();
    },
    close() {
      closed = true; clearTimeout(timer); timer = null;
      for (const [id, entry] of pending) { clearTimeout(entry.guard); entry.reject(fail('Unreachable')); pending.delete(id); }
      socket?.destroy();
    },
  };
}

exports.service = async (panda, lifetime) => {
  const link = tcpLink(process.env.PANDA_FIXTURE_B1 || '');
  lifetime.onStop(() => link.close());
  const { run } = await import('./lib/board.mjs');
  await run(panda, lifetime, link);
};
