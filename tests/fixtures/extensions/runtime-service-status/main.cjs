// R0107 fixture: a background service whose status line feeds the Running list and the quit confirmation.
// Native tests hand it B1's TCP address in PANDA_FIXTURE_B1; every B1 signal named `status` sets its status line
// from the signal's payload ({text, working}). It records each start and stop reason in B1 (issues titled
// `start:<reason>` / `stop:<reason>`) and keeps one 4096-byte file in its data directory, so the Running list's
// data size has something to measure. Without B1 it only idles.
const net = require('node:net');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');

exports.service = async (panda, lifetime) => {
  const address = process.env.PANDA_FIXTURE_B1 || '';
  let socket = null, buffer = '', sequence = 0;
  const pending = new Map();
  const request = (op, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, op, params })}\n`);
  });
  panda.commands.register('sample.service-status/state', async () => null);
  try {
    const global = await panda.storage.directory({ scope: 'global' });
    writeFileSync(join(global.path, 'state.bin'), Buffer.alloc(4096, 1));
  } catch { /* no storage.private grant: nothing to keep */ }
  if (address) {
    const [host, port] = address.split(':');
    socket = net.connect({ host, port: Number(port) });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (frame.event === 'signal') {
          const signal = frame.data || {};
          if (signal.name === 'status') void lifetime.setStatus({ text: String(signal.payload?.text ?? ''), working: signal.payload?.working === true });
          continue;
        }
        const waiter = pending.get(frame.id); if (!waiter) continue;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.result); else waiter.reject(new Error(frame.error?.code || 'Failed'));
      }
    });
    await request('hello', {});
    await request('subscribe', { topic: 'signals' });
    await request('issues.create', { title: `start:${lifetime.reason}` });
  }
  lifetime.onStop(async reason => {
    if (!socket) return;
    await request('issues.create', { title: `stop:${reason}` });
    socket.end();
  });
  await lifetime.setStatus({ text: 'Idle', working: false });
};
