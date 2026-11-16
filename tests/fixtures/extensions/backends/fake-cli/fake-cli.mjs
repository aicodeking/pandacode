import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { cliOperation } from '../core/fake-cli.mjs';
import { integer, lines, main } from '../common.mjs';

export async function runCli(argv, env = process.env, signal) {
  let daemon, jsonMode = false;
  const command = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--daemon') daemon = argv[++i];
      else if (argv[i].startsWith('--daemon=')) daemon = argv[i].slice(9);
      else if (argv[i] === '--json') jsonMode = true;
      else command.push(argv[i]);
    }
    if (!jsonMode || !/^127\.0\.0\.1:\d+$/.test(daemon ?? '')) throw new Error('Expected --daemon 127.0.0.1:<port> --json');
    integer(daemon.split(':')[1], 0, 1);
    const operation = cliOperation(command);
    const wait = integer(env.FAKE_CLI_DELAY_MS, 0, 0, 3600000), padding = integer(env.FAKE_CLI_PAD_BYTES, 0, 0, 16777216);
    await delay(wait, undefined, { signal });
    if (env.FAKE_CLI_FAIL) return { code: 1, value: { error: { code: env.FAKE_CLI_FAIL, message: 'Injected failure' } }, padding };
    const value = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(daemon.split(':')[1]) });
      let serial = 0;
      const pending = new Map();
      const finish = error => { for (const request of pending.values()) request.reject(error); pending.clear(); socket.destroy(); };
      const abort = () => finish(new Error('Cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      socket.setTimeout(5000, () => finish(new Error('Daemon timeout')));
      socket.on('error', error => { finish(error); reject(error); });
      socket.on('close', () => { signal?.removeEventListener('abort', abort); finish(new Error('Daemon disconnected')); reject(new Error('Daemon disconnected')); });
      const request = (op, params = {}) => new Promise((resolve_, reject_) => {
        const id = ++serial; pending.set(id, { resolve: resolve_, reject: reject_ });
        socket.write(`${JSON.stringify({ id, op, params })}\n`);
      });
      lines(socket, response => {
        const task = pending.get(response.id);
        if (!task) return;
        pending.delete(response.id);
        if (response.ok) task.resolve(response.result);
        else task.reject(Object.assign(new Error(response.error.message), { daemonError: response.error }));
      }, message => finish(new Error(message)));
      socket.once('connect', async () => {
        try {
          let result = await request(operation.op, operation.params);
          if (result.transfer) {
            const parts = [];
            for (let index = 0; index < result.chunks; index++) parts.push((await request('issues.chunk', { transfer: result.transfer, index })).text);
            result = JSON.parse(parts.join(''));
          }
          resolve(operation.project ? operation.project(result) : result);
        } catch (error) { reject(error); } finally { socket.destroy(); }
      });
    });
    return { code: 0, value, padding };
  } catch (error) {
    return { code: error.daemonError ? 1 : error.code || /Daemon|Cancelled|connect|socket|ECONN/.test(error.message) ? 3 : 2, value: { error: error.daemonError ?? { code: error.code ?? 'UsageError', message: error.message } }, padding: 0 };
  }
}
if (main(import.meta.url)) {
  const controller = new AbortController();
  process.stdin.resume();
  process.stdin.once('end', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const result = await runCli(process.argv.slice(2), process.env, controller.signal);
  process.stdout.write(`${JSON.stringify(result.value)}${' '.repeat(result.padding)}\n`);
  process.stdin.destroy(); process.exitCode = result.code;
}
