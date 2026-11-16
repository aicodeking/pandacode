import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lines } from './common.mjs';

export function queue() {
  const values = [], waiting = [];
  function push(value) {
    const index = waiting.findIndex(item => item.match(value));
    if (index < 0) values.push(value);
    else { const [item] = waiting.splice(index, 1); clearTimeout(item.timer); item.resolve(value); }
  }
  function next(match = () => true, ms = 4000) {
    const at = values.findIndex(match);
    if (at >= 0) return Promise.resolve(values.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { match, resolve, reject };
      item.timer = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('Fixture frame timeout')); }, ms);
      waiting.push(item);
    });
  }
  return { push, next, values };
}
export function program(t, relative, argv = [], env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(relative, import.meta.url)), ...argv], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, windowsHide: true });
  const out = queue(), err = queue(); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  lines(child.stdout, out.push, value => out.push({ invalid: value }));
  lines(child.stderr, err.push, () => {});
  const exited = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      let timer, forced = false;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { forced = true; child.kill(); resolve(); }, 1500); })]);
      clearTimeout(timer);
      await exited;
      if (forced) throw new Error(`Fixture failed to stop on EOF: ${relative}`);
    }
  });
  return { child, out, err, exited, send: value => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`) };
}
export async function control(url, path, value = {}) {
  try {
    const response = await fetch(`${url}/control/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(4000) });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  } catch (error) { throw new Error(`Control ${path}: ${error.message}`, { cause: error }); }
}
export async function tcp(t, address) {
  const [host, port] = address.split(':'), socket = net.createConnection({ host, port: Number(port) }), frames = queue();
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  lines(socket, frames.push, value => frames.push({ invalid: value }));
  await once(socket, 'connect'); let serial = 0;
  return { socket, frames, async request(op, params = {}) {
    const id = ++serial;
    socket.write(`${JSON.stringify({ id, op, params })}\n`);
    return frames.next(frame => frame.id === id);
  } };
}
export async function evidence(name) {
  const folder = new URL('./evidence/', import.meta.url);
  await mkdir(folder, { recursive: true });
  return fileURLToPath(new URL(name, folder));
}
