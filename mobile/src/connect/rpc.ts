// App-protocol framing and pending calls (docs/remote-access.md, "App protocol");
// mirrors src-tauri/src/remote/client.rs.
import { randomBytes, uuid } from './crypto.ts';

/** The host's built-in methods (`METHODS` in src-tauri/src/remote/host.rs; tests/rpc.test.ts
 * keeps them in sync) plus `host.hello`. Feature methods from the host's `methods/` registry are
 * declared by their src/connect/api/<feature>.ts file with `registerMethods`, so this list never
 * needs editing for them. */
export const METHODS = ['subscribe', 'tasks.list', 'projects.icons', 'providers.list', 'providers.models', 'task.start', 'task.startStatus', 'task.cancelStart',
  'task.messages', 'task.team', 'task.workerMessages', 'task.attachment', 'task.workspaceImage', 'task.send', 'task.stop', 'task.teamResume', 'task.steer',
  'task.configure', 'approval.respond', 'input.respond', 'task.pull', 'task.pullDiff', 'task.pullMerge', 'task.pullDetect', 'task.changes', 'task.diff',
  'bots.list', 'bot.thread', 'bot.message', 'bot.pause', 'image.put', 'batch', 'pair.redeem', 'host.hello'] as const;
export type CoreMethod = (typeof METHODS)[number];
/** A core method (autocompleted) or one a feature file registered. */
export type Method = CoreMethod | (string & {});

const METHOD_NAME = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const known = new Set<string>(METHODS);

/** Declares registry methods a feature file calls (src/connect/api/*.ts), once at module load;
 * `request` refuses any method neither listed above nor registered. Returns the names, typed. */
export function registerMethods<const T extends readonly string[]>(names: T): T {
  for (const name of names) {
    if (name.length > 64 || !METHOD_NAME.test(name)) throw new Error(`Invalid method name: ${name}`);
    known.add(name);
  }
  return names;
}

export const isKnownMethod = (method: string) => known.has(method);

export const TIMEOUT_MS = 20_000;
/** The host's worst case for task.start is about 9.5 minutes; wait 3 minutes longer. */
export const START_TIMEOUT_MS = 12.5 * 60_000;
const MAX_PARAMS = 110 * 1024;
export const OFFLINE = 'That computer is offline.';
export const RATE = 'Too many requests to that computer. Try again in a moment.';
export const LOST = 'The connection to the relay was lost.';
export const NOT_CONNECTED = 'Not connected to the relay.';
export const TIMED_OUT = 'That computer did not answer in time.';
/** A call that timed out or lost the socket while waiting may still have run on the host
 * (unlike OFFLINE or NOT_CONNECTED, which were never delivered), as in client.rs. */
export const maybeRan = (error: unknown) => {
  const message = error instanceof Error ? error.message : error;
  return message === TIMED_OUT || message === LOST;
};
/** A newer host's refusal of a request that waited too long in its queue: it never ran, and
 * neither did an earlier copy with its `sendId` (that one is answered instead). */
export const NOT_RUN = 'This request waited too long on the other computer and did not run. Try again.';
/** An older host's refusal of a request that waited too long. This copy never ran, but an
 * earlier copy with the same `sendId` may have, so a prompt refused this way may have gone. */
export const DROPPED = 'This request waited too long on the other computer and was dropped. Try again.';
/** Whether a prompt sent with a `sendId` (`task.send`, `task.steer`, `bot.message`) may have
 * run despite this error: a lost reply, or an older host's queue expiry. */
export const promptMaybeRan = (error: unknown) => {
  const message = error instanceof Error ? error.message : error;
  return maybeRan(error) || message === DROPPED;
};
/** An older desktop's answer to a method it doesn't have. */
export const UNKNOWN_METHOD = 'Unknown method.';
export const outdated = (computer: string) => `Update PandaCode on ${computer} to use this.`;

/** `z: 1`: this phone opens packed (deflated) replies and events. */
export interface Request { type: 'req'; id: string; method: Method; params: unknown; ts: number; nonce: string; z: 1 }

export function request(method: Method, params: unknown, now = Date.now()): Request {
  if (!known.has(method)) throw new Error('Unknown remote method.');
  if (JSON.stringify(params).length > MAX_PARAMS) throw new Error('That request is too large.');
  // `ts` and a fresh `nonce` let the host refuse replays.
  const nonce = Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
  return { type: 'req', id: uuid(), method, params, ts: now, nonce, z: 1 };
}

const WINDOW_MS = 60_000;
const MAX_SEEN = 20_000;
/** A reply that failed the replay check fails its call at once instead of timing out. */
export const STALE = "That computer's reply was stale or repeated. Update PandaCode on both computers and check their clocks.";

/** Nonces of replies and events from hosts, as the host keeps them for requests
 * (`Replay` in host.rs): outside ±60 s, repeated, or without ts/nonce is refused. */
export class Replay {
  private readonly seen = new Map<string, number>();

  check(ts: unknown, nonce: unknown, now = Date.now()): boolean {
    if (typeof ts !== 'number' || typeof nonce !== 'string' || !/^[\x21-\x7e]{16,64}$/.test(nonce) || Math.abs(now - ts) > WINDOW_MS) return false;
    for (const [seen, at] of this.seen) if (at < now - WINDOW_MS) this.seen.delete(seen);
    if (this.seen.has(nonce) || this.seen.size >= MAX_SEEN) return false;
    this.seen.set(nonce, ts);
    return true;
  }
}

interface Call { device: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Calls waiting for a response, keyed by request id. */
export class Pending {
  private readonly calls = new Map<string, Call>();

  wait(device: string, id: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(TIMED_OUT));
      }, timeoutMs);
      this.calls.set(id, { device, resolve, reject, timer });
    });
  }

  private settle(id: string, error: string | null, value?: unknown) {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    clearTimeout(call.timer);
    if (error === null) call.resolve(value);
    else call.reject(new Error(error));
  }

  /** A response settles its call only when it comes from the device it was sent to. */
  resolve(from: string, message: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }) {
    if (typeof message.id !== 'string' || this.calls.get(message.id)?.device !== from) return;
    const error = typeof message.error === 'string' ? message.error.slice(0, 1000) : 'The other computer refused the request.';
    this.settle(message.id, message.ok === true ? null : error, message.result);
  }

  /** Undeliverable: with a ref fail that call, without one every call to `device`. */
  fail(device: string, ref: string | undefined, error: string) {
    for (const [id, call] of this.calls) if (call.device === device && (ref === undefined || ref === id)) this.settle(id, error);
  }

  failAll(error: string) {
    for (const id of [...this.calls.keys()]) this.settle(id, error);
  }

  get size() { return this.calls.size; }
}

/**
 * Background calls (prefetch, icons, attachments, glance subscribes, bots) take turns per host:
 * the host answers one phone's requests in order, so at most one waits ahead of anything the
 * user does. User calls skip this and go at once. FIFO; `turn` resolves with the release.
 */
export class BackgroundGate {
  private readonly queues = new Map<string, (() => void)[]>();

  turn(host: string): Promise<() => void> {
    const release = () => {
      const queue = this.queues.get(host) ?? [];
      const next = queue.shift();
      if (next) next();
      else this.queues.delete(host);
    };
    const queue = this.queues.get(host);
    if (!queue) {
      this.queues.set(host, []);
      return Promise.resolve(release);
    }
    return new Promise(resolve => queue.push(() => resolve(release)));
  }

  /** Background calls waiting (not the one in flight). */
  waiting(host: string) { return this.queues.get(host)?.length ?? 0; }
}
