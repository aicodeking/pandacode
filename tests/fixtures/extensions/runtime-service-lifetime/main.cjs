// R0104 fixture: one background service (runtime.service) driven by the canonical B1 fake daemon.
// Native tests hand it B1's TCP address in PANDA_FIXTURE_B1; without it the service only idles.
// It records every start and stop reason in B1 (issues titled `start:<reason>` / `stop:<reason>`),
// counts B1 signals in its status line, and optionally owns a helper process to prove tree teardown.
const net = require('node:net');

exports.service = async (panda, lifetime) => {
  const address = process.env.PANDA_FIXTURE_B1 || '';
  const mode = process.env.PANDA_FIXTURE_MODE || '';
  let signals = 0, sequence = 0, socket = null, buffer = '';
  const pending = new Map();
  const helper = process.env.PANDA_FIXTURE_HELPER === '1'
    ? require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    : null;
  const report = () => lifetime.setStatus({ text: JSON.stringify({ reason: lifetime.reason, signals, host: process.pid, helper: helper ? helper.pid : null }) });
  const request = (op, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, op, params })}\n`);
  });
  // The command handler lives in the service's shared state (dispatch into it arrives with R0201).
  panda.commands.register('sample.service-lifetime/long', async () => { signals += 0; });
  if (address) {
    const [host, port] = address.split(':');
    socket = net.connect({ host, port: Number(port) });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (frame.event === 'signal') { signals += 1; void report(); continue; }
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
  await report();
  if (mode === 'hang') return new Promise(() => {});
  if (mode === 'throw') throw new Error('Broken service fixture');
};

// A short activation of the same package: a long command (3 s, under the 5 s activation deadline).
exports.activate = panda => {
  panda.commands.register('sample.service-lifetime/long', () => new Promise(resolve => setTimeout(resolve, 3000)));
};
