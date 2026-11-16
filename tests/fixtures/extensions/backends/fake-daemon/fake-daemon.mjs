import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { createDaemon } from '../core/fake-daemon.mjs';
import { args, body, integer, json, lifetime, lines, listen, listener, main } from '../common.mjs';

export async function startDaemon({ port = 0, controlPort = 0, seed = {} } = {}) {
  integer(port, 0, 0, 0); integer(controlPort, 0, 0, 0);
  const peers = new Map(), log = [];
  let fault = null, timer, closed = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const activeFault = () => fault && (fault.until === null || Date.now() < fault.until) ? fault.kind : null;
  const send = (socket, value) => {
    if (socket.destroyed) return;
    let text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 65536) text = JSON.stringify({ id: value.id, ok: false, error: { code: 'FrameTooLarge', message: 'Use a chunked issues.snapshot for large data' } });
    socket.write(`${text}\n`);
  };
  const state = createDaemon({ seed, emit(topic, frame) {
    for (const [socket, peer] of peers) if (peer.topics.has(topic)) send(socket, frame);
  } });
  const data = net.createServer(socket => {
    if (activeFault() === 'refuse') { socket.destroy(); return; }
    const peer = { topics: new Set(), intervalMs: 1000, due: 0 };
    peers.set(socket, peer);
    socket.on('error', () => {});
    socket.on('close', () => { peers.delete(socket); log.push({ transport: 'tcp', event: 'close' }); });
    lines(socket, request => {
      log.push({ transport: 'tcp', request });
      if (activeFault() === 'stall') return;
      const params = request.params ?? request;
      try {
        if (request.op === 'subscribe' && params.topic === 'metrics') peer.intervalMs = integer(params.intervalMs, 1000, 100, 60000);
        const result = state.request(request.op, params);
        send(socket, { id: request.id, ok: true, result });
        if (request.op === 'subscribe') { peer.topics.add(params.topic); peer.due = Date.now() + peer.intervalMs; }
      } catch (error) { send(socket, { id: request.id, ok: false, error: { code: error.code ?? 'InvalidArgument', message: error.message } }); }
    }, message => { send(socket, { ok: false, error: { code: 'InvalidFrame', message } }); socket.end(); });
  });
  const control = listener(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const raw = await body(req);
    log.push({ transport: 'http', method: req.method, path, headers: req.headers, body: raw });
    if (req.method === 'GET' && path === '/control/log') return json(res, log);
    if (req.method !== 'POST' || !path.startsWith('/control/')) return json(res, { error: 'NotFound' }, 404);
    const value = raw ? JSON.parse(raw) : {};
    if (path === '/control/shutdown') { json(res, { stopped: true }); setImmediate(close); return; }
    if (path === '/control/fault') {
      if (!['drop', 'stall', 'garbage', 'refuse'].includes(value.kind)) throw new Error('Unknown fault');
      fault = { kind: value.kind, until: value.ms === undefined ? null : Date.now() + integer(value.ms, 0, 0, 3600000) };
      if (value.kind === 'drop' || value.kind === 'refuse') for (const socket of peers.keys()) socket.destroy();
      if (value.kind === 'garbage') for (const socket of peers.keys()) socket.write('not-json\n');
      return json(res, { fault: value.kind });
    }
    if (path === '/control/reset') { fault = null; log.length = 0; }
    json(res, state.control(path.slice('/control/'.length), value));
  });
  async function close() {
    if (closed) return;
    closed = true; clearInterval(timer);
    for (const socket of peers.keys()) socket.destroy();
    await Promise.all([control.close(), new Promise(resolve => data.close(resolve))]);
    resolveDone();
  }
  try {
    await new Promise((resolve, reject) => { data.once('error', reject); data.listen(integer(port, 0), '127.0.0.1', resolve); });
    const url = await listen(control.server, controlPort);
    timer = setInterval(() => {
      if (activeFault() === 'stall') return;
      const due = [...peers.values()].filter(peer => peer.topics.has('metrics') && peer.due <= Date.now());
      if (!due.length) return;
      const frames = [];
      // Capture each machine once, then deliver only to the subscriptions due now.
      const held = new Map(peers);
      for (const [socket, peer] of held) if (!due.includes(peer)) peers.delete(socket);
      for (const item of state.request('metrics.machines')) { const frame = state.sample(item.id); if (frame) frames.push(frame); }
      for (const [socket, peer] of held) peers.set(socket, peer);
      for (const peer of due) peer.due = Date.now() + peer.intervalMs;
    }, 25);
    return { state, close, done, ready: { ready: true, socket: `127.0.0.1:${data.address().port}`, control: url } };
  } catch (error) { await close(); throw error; }
}
if (main(import.meta.url)) {
  try {
    const { options, rest } = args(process.argv.slice(2), ['port', 'control-port', 'seed']);
    if (rest.length) throw new Error('Unexpected positional argument');
    const seed = options.seed ? JSON.parse(await readFile(options.seed, 'utf8')) : {};
    const helper = await startDaemon({ port: options.port, controlPort: options['control-port'], seed });
    lifetime(helper.close, helper.done);
    console.log(JSON.stringify(helper.ready));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
