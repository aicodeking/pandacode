import { createHash, randomUUID } from 'node:crypto';
import { createCloud } from '../core/fake-cloud.mjs';
import { args, body, integer, json, lifetime, listen, listener, main } from '../common.mjs';

export async function startCloud({ identityPort = 0, apiPort = 0 } = {}) {
  integer(identityPort, 0, 0, 0); integer(apiPort, 0, 0, 0);
  const state = createCloud({ challenge: text => createHash('sha256').update(text).digest('base64url'), token: () => `tok-${randomUUID()}` });
  const log = [], listeners = [];
  let fault, stopped = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const handler = kind => async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), raw = await body(req);
    log.push({ listener: kind, method: req.method, path: req.url, headers: req.headers, body: raw });
    if (url.pathname === '/control/log' && req.method === 'GET') return json(res, log);
    if (url.pathname.startsWith('/control/') && req.method === 'POST') {
      const value = raw ? JSON.parse(raw) : {}, path = url.pathname.slice(9);
      if (path === 'shutdown') { json(res, { stopped: true }); setImmediate(close); return; }
      if (path === 'fault') {
        if (!['drop', 'stall', 'garbage', 'refuse'].includes(value.kind)) throw new Error('Unknown fault');
        fault = { kind: value.kind, until: value.ms === undefined ? Infinity : Date.now() + integer(value.ms, 0, 0, 3600000) };
        json(res, { fault: value.kind });
        if (value.kind === 'drop') for (const item of listeners) item.drop(req.socket);
        return;
      }
      if (path === 'reset') { log.length = 0; fault = null; }
      return json(res, state.control(path, value));
    }
    if (fault && Date.now() < fault.until) {
      if (fault.kind === 'stall') return;
      if (fault.kind === 'refuse') { req.socket.destroy(); return; }
      if (fault.kind === 'garbage') { res.end('not-json'); return; }
    }
    const data = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : {};
    const result = await state.request(kind, req.method, url, req.headers, data);
    if (result.hang) return;
    if (result.html) { res.writeHead(result.status, { 'content-type': 'text/html' }); res.end(result.html); return; }
    if (result.events) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const event of result.events) res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
      res.end(); return;
    }
    json(res, result.data, result.status, result.headers);
  };
  async function close() {
    if (stopped) return;
    stopped = true;
    await Promise.all(listeners.map(item => item.close())); resolveDone();
  }
  listeners.push(listener(handler('identity')), listener(handler('api')));
  try {
    const identity = await listen(listeners[0].server, identityPort), api = await listen(listeners[1].server, apiPort);
    return { state, close, done, ready: { ready: true, identity, api, control: identity } };
  } catch (error) { await close(); throw error; }
}
if (main(import.meta.url)) {
  try {
    const { options, rest } = args(process.argv.slice(2), ['identity-port', 'api-port']);
    if (rest.length) throw new Error('Unexpected positional argument');
    const helper = await startCloud({ identityPort: options['identity-port'], apiPort: options['api-port'] });
    lifetime(helper.close, helper.done); console.log(JSON.stringify(helper.ready));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
