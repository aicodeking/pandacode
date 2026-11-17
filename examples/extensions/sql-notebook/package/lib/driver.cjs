// The installed driver of the SQL notebook: one short-lived Node process per query (lib/worker.cjs, argument array, no
// shell, hidden window), a timeout that ends the process and a cancel that does the same earlier. Nothing else in the
// package touches a database file. Ending the process stops even a statement that never gives control back to
// JavaScript, which a worker thread could not.
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER = path.join(__dirname, 'worker.cjs');
const MAX_ANSWER = 16 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message ?? code), { code });

/** Raw worker values back to what the page logic understands: `{ int }` is a bigint, `{ blob }` stays a size marker. */
const revive = value => (value && typeof value === 'object' && typeof value.int === 'string' ? BigInt(value.int) : value);

function createDriver() {
  const live = new Map();
  let sequence = 0;

  const call = (id, request, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', finished = false;
    const end = (settle, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); live.delete(id);
      try { child.kill(); } catch { /* already gone */ }
      settle(value);
    };
    const timer = timeoutMs ? setTimeout(() => end(reject, fail('Timeout')), timeoutMs) : null;
    live.set(id, { stop: () => end(reject, fail('Cancelled')) });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; if (out.length > MAX_ANSWER) end(reject, fail('LimitExceeded', 'The result is too large to show.')); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (err.length < 4096) err += chunk; });
    child.on('error', error => end(reject, fail('HostUnavailable', String(error?.message ?? error))));
    child.on('close', () => {
      if (finished) return;
      let message;
      try { message = JSON.parse(out); } catch { end(reject, fail('SqlError', err.trim() || 'The database process stopped without an answer.')); return; }
      if (message.ok) end(resolve, message); else end(reject, fail(message.code ?? 'SqlError', message.message));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
  });

  return {
    async run({ id, file, sql, limit, timeoutMs, readOnly }) {
      const message = await call(id, { file, sql, limit, readOnly, mode: 'query' }, timeoutMs);
      return { columns: message.columns, rows: message.rows.map(row => row.map(revive)), changes: message.changes ?? 0 };
    },
    cancel(id) { live.get(id)?.stop(); },
    async tables(file) { return (await call(`tables-${++sequence}`, { file, readOnly: true, mode: 'tables' }, 5000)).tables; },
    async check(file) { await call(`check-${++sequence}`, { file, readOnly: true, mode: 'check' }, 5000); },
    stopAll() { for (const entry of [...live.values()]) entry.stop(); },
  };
}

module.exports = { createDriver };
