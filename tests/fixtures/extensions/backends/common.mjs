import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const main = url => process.argv[1] && url === pathToFileURL(process.argv[1]).href;
export function args(argv, names) {
  const options = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { rest.push(argv[i]); continue; }
    const [name, inline] = argv[i].slice(2).split(/=(.*)/s);
    if (!names.includes(name)) throw new Error(`Unknown option: --${name}`);
    options[name] = inline ?? argv[++i];
    if (options[name] === undefined) throw new Error(`Missing value: --${name}`);
  }
  return { options, rest };
}
export function integer(value, fallback, min = 0, max = 65535) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid integer: ${value}`);
  return n;
}
export function loopback(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Only numeric HTTP loopback is supported');
  return url;
}
export function json(response, value, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}
export async function body(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Body exceeds 1 MiB');
  }
  return data;
}
export function listener(handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    // Fault controls use fresh connections; a drop must not poison their pool.
    if (req.url?.startsWith('/control/')) res.setHeader('connection', 'close');
    Promise.resolve(handler(req, res)).catch(error => {
      if (!res.headersSent) json(res, { error: { code: 'BadRequest', message: error.message } }, 400);
      else res.destroy();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return { server, drop: except => { for (const socket of [...sockets]) if (socket !== except) socket.destroy(); }, close: () => new Promise(resolve => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  }) };
}
export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(integer(port, 0), '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
export function lifetime(close, done) {
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await close();
    process.stdin.pause();
    process.stdin.destroy();
  };
  process.stdin.resume();
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  done?.then(stop);
  return stop;
}
export function lines(stream, receive, invalid = () => {}) {
  let pending = Buffer.alloc(0);
  stream.on('data', chunk => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (pending.includes(10)) {
      const at = pending.indexOf(10), line = pending.subarray(0, at);
      pending = pending.subarray(at + 1);
      if (line.length > 65536) { invalid('Line exceeds 64 KiB'); return; }
      if (!line.toString().trim()) continue;
      try { receive(JSON.parse(line.toString('utf8'))); } catch (error) { invalid(error.message); }
    }
    if (pending.length > 65536) { pending = Buffer.alloc(0); invalid('Line exceeds 64 KiB'); }
  });
}
