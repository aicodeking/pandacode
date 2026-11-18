// Groups a host's read-only calls made together into one `batch` request (docs/remote-access.md,
// "Batch"): after a reconnect the task list, the subscribe and the open threads' catch-up pages
// go in one round trip instead of several. Only for hosts whose host.hello lists `batch`, and
// only while client.ts opens a window for it. A result the host left out to fit its reply (or a
// host that refuses the batch) is fetched on its own. Pure: the transport is injected.
import { UNKNOWN_METHOD, type Method } from './rpc.ts';

/** The calls a batch may carry: read-only on every host that serves `batch`. */
export const BATCHABLE: ReadonlySet<string> = new Set(['tasks.list', 'subscribe', 'task.messages']);
/** How long calls wait for others to join (one macrotask, so every caller of this tick joins). */
export const JOIN_MS = 0;
const OMITTED = /^Result omitted to keep the batch reply/;

export interface BatchDeps {
  /** One request on the wire. */
  send: (deviceId: string, method: Method, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Calls a batch to this host may carry now: below 2 means no batching. */
  limit: (deviceId: string) => number;
  later?: (run: () => void, ms: number) => void;
}

interface Entry { method: Method; params: unknown; timeoutMs: number; resolve: (value: unknown) => void; reject: (error: unknown) => void }

interface BatchReply { results?: { ok?: unknown; result?: unknown; error?: unknown }[] }

export class Batcher {
  private readonly queues = new Map<string, Entry[]>();

  private readonly deps: BatchDeps;

  constructor(deps: BatchDeps) {
    this.deps = deps;
  }

  call(deviceId: string, method: Method, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!BATCHABLE.has(method) || this.deps.limit(deviceId) < 2) return this.deps.send(deviceId, method, params, timeoutMs);
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(deviceId);
      const entry = { method, params, timeoutMs, resolve, reject };
      if (queue) return void queue.push(entry);
      this.queues.set(deviceId, [entry]);
      (this.deps.later ?? ((run, ms) => void setTimeout(run, ms)))(() => this.drain(deviceId), JOIN_MS);
    });
  }

  private drain(deviceId: string) {
    const queue = this.queues.get(deviceId) ?? [];
    this.queues.delete(deviceId);
    const limit = Math.max(1, this.deps.limit(deviceId));
    for (let i = 0; i < queue.length; i += limit) void this.flush(deviceId, queue.slice(i, i + limit));
  }

  private alone(deviceId: string, entry: Entry) {
    // From a timer: a send that throws at once (offline, too large) must still settle its call.
    Promise.resolve().then(() => this.deps.send(deviceId, entry.method, entry.params, entry.timeoutMs)).then(entry.resolve, entry.reject);
  }

  private async flush(deviceId: string, entries: Entry[]) {
    if (entries.length === 1) return this.alone(deviceId, entries[0]);
    let reply: BatchReply;
    try {
      const calls = entries.map(e => ({ method: e.method, params: e.params }));
      reply = (await this.deps.send(deviceId, 'batch', { calls }, Math.max(...entries.map(e => e.timeoutMs)))) as BatchReply;
    } catch (error) {
      // A host without batch (or refusing one of these in it) answers each call on its own.
      const message = error instanceof Error ? error.message : '';
      if (message === UNKNOWN_METHOD || /^Batch /.test(message)) return entries.forEach(e => this.alone(deviceId, e));
      return entries.forEach(e => e.reject(error));
    }
    const results = Array.isArray(reply?.results) ? reply.results : [];
    entries.forEach((entry, i) => {
      const result = results[i];
      if (result?.ok === true) return entry.resolve(result.result);
      const error = typeof result?.error === 'string' ? result.error.slice(0, 1000) : '';
      if (!result || OMITTED.test(error)) return this.alone(deviceId, entry);
      entry.reject(new Error(error || 'The other computer refused the request.'));
    });
  }
}
