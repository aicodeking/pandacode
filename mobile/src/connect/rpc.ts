// App-protocol framing and pending calls (docs/remote-access.md, "App protocol");
// mirrors src-tauri/src/remote/client.rs.
import { randomBytes, uuid } from './crypto.ts';

export const METHODS = ['subscribe', 'tasks.list', 'providers.list', 'providers.models', 'task.start', 'task.messages', 'task.send', 'task.stop', 'task.steer', 'task.configure', 'approval.respond', 'input.respond', 'projects.icons'] as const;
export type Method = (typeof METHODS)[number];

export const TIMEOUT_MS = 20_000;
/** The host's worst case for task.start is about 9.5 minutes; wait 3 minutes longer. */
export const START_TIMEOUT_MS = 12.5 * 60_000;
const MAX_PARAMS = 110 * 1024;
export const OFFLINE = 'That computer is offline.';
export const RATE = 'Too many requests to that computer. Try again in a moment.';
export const LOST = 'The connection to the relay was lost.';
export const NOT_CONNECTED = 'Not connected to the relay.';

export interface Request { type: 'req'; id: string; method: Method; params: unknown; ts: number; nonce: string }

export function request(method: Method, params: unknown, now = Date.now()): Request {
  if (!METHODS.includes(method)) throw new Error('Unknown remote method.');
  if (JSON.stringify(params).length > MAX_PARAMS) throw new Error('That request is too large.');
  // `ts` and a fresh `nonce` let the host refuse replays.
  const nonce = Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
  return { type: 'req', id: uuid(), method, params, ts: now, nonce };
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
        reject(new Error('That computer did not answer in time.'));
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
