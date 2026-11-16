// Duplex channel between the host and a background service (runtime phase R2, slice R0201).
//
// The native rules live in src-tauri/src/extensions/runtime_duplex_channel.rs; this file mirrors them with no I/O
// and an injected clock, for the browser preview and for the deterministic checks of
// tests/extensions-runtime-duplex-channel.spec.ts. One pipe carries two kinds of traffic that never wait for
// each other: service requests answered by the host, and host calls (owned commands) answered by the service.
// Each direction is bounded for predictability, never for trust: 2 MiB per frame, 64 calls pending, and an average
// of 200 requests per second over 10 seconds.

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_PENDING = 64;
export const RATE_PER_SECOND = 200;
export const RATE_WINDOW_MS = 10_000;

export type DuplexCode = 'LimitExceeded' | 'InvalidShape' | 'HostUnavailable' | 'Cancelled' | 'PermissionDenied' | 'StaleContext' | 'UnsupportedCapability';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Sliding-window request budget: `RATE_PER_SECOND * RATE_WINDOW_MS / 1000` requests in any window. */
export class Budget {
  private stamps: number[] = [];
  admit(now: number): DuplexCode | null {
    while (this.stamps.length && now - this.stamps[0] >= RATE_WINDOW_MS) this.stamps.shift();
    if (this.stamps.length >= RATE_PER_SECOND * (RATE_WINDOW_MS / 1000)) return 'LimitExceeded';
    this.stamps.push(now);
    return null;
  }
}

/** Correlation state of one service connection. `W` is whatever settles a host call. */
export class DuplexChannel<W> {
  private next = 0;
  private calls = new Map<number, W>();
  private served = new Set<number>();
  private outbound = new Budget();
  private inbound = new Budget();
  pendingCalls() { return this.calls.size; }
  pendingRequests() { return this.served.size; }

  /** Registers a host to service call; ids are never reused. A refusal returns its code and leaves no trace. */
  beginCall(now: number, waiter: W): { id: number } | { code: DuplexCode } {
    if (this.calls.size >= MAX_PENDING) return { code: 'LimitExceeded' };
    const refused = this.outbound.admit(now);
    if (refused) return { code: refused };
    this.next += 1;
    this.calls.set(this.next, waiter);
    return { id: this.next };
  }
  /** Takes the waiter of `id`. A late, repeated or unknown id returns `undefined` and touches no other call. */
  settle(id: number): W | undefined {
    const waiter = this.calls.get(id);
    this.calls.delete(id);
    return waiter;
  }
  /** Settles every outstanding call (disconnect, disable, trust loss), oldest first. */
  settleAll(): Array<[number, W]> {
    const all = [...this.calls.entries()];
    this.calls.clear();
    return all;
  }
  /** Admits a service to host request: `InvalidShape` for an id already in flight, `LimitExceeded` over a bound. */
  beginRequest(id: number, now: number): DuplexCode | null {
    if (this.served.has(id)) return 'InvalidShape';
    if (this.served.size >= MAX_PENDING) return 'LimitExceeded';
    const refused = this.inbound.admit(now);
    if (refused) return refused;
    this.served.add(id);
    return null;
  }
  finishRequest(id: number) { return this.served.delete(id); }
}

export type Incoming =
  | { kind: 'request'; schemaVersion: number; token: string; id: number; method: string; params: Json }
  | { kind: 'reply'; schemaVersion: number; token: string; id: number; result: { ok: true; value: Json } | { ok: false; code: string } };

const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, Json>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Classifies one frame; anything that is not exactly a request or a reply is `InvalidShape` (`null`). */
export function classify(raw: unknown): Incoming | null {
  if (!isObject(raw) || !natural(raw.schemaVersion) || typeof raw.token !== 'string') return null;
  if (Object.hasOwn(raw, 'reply')) {
    const reply = raw.reply;
    if (!exact(raw, ['schemaVersion', 'token', 'reply']) || !isObject(reply) || !natural(reply.id) || typeof reply.ok !== 'boolean') return null;
    if (reply.ok && exact(reply, ['id', 'ok', 'value'])) return { kind: 'reply', schemaVersion: raw.schemaVersion, token: raw.token, id: reply.id, result: { ok: true, value: reply.value } };
    if (!reply.ok && exact(reply, ['id', 'ok', 'error'])) {
      const code = isObject(reply.error) ? reply.error.code : undefined;
      return { kind: 'reply', schemaVersion: raw.schemaVersion, token: raw.token, id: reply.id, result: { ok: false, code: typeof code === 'string' && /^[A-Za-z0-9]{1,64}$/.test(code) ? code : 'HostUnavailable' } };
    }
    return null;
  }
  if (!exact(raw, ['schemaVersion', 'token', 'id', 'method', 'params']) || !natural(raw.id) || typeof raw.method !== 'string') return null;
  return { kind: 'request', schemaVersion: raw.schemaVersion, token: raw.token, id: raw.id, method: raw.method, params: raw.params };
}

export const callFrame = (id: number, method: string, params: Json) => ({ call: { id, method, params } });
export const answerFrame = (id: number, reply: Json) => ({ id, reply });

/** Serialises one frame body; `LimitExceeded` over 2 MiB (exactly 2 MiB still fits). */
export function encode(value: Json): { bytes: Uint8Array } | { code: 'LimitExceeded' } {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length > MAX_FRAME_BYTES) return { code: 'LimitExceeded' };
  const frame = new Uint8Array(body.length + 4);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, 4);
  return { bytes: frame };
}

/** Decodes the first frame of `bytes`. A zero or over-2-MiB length is refused before any body is read. */
export function decode(bytes: Uint8Array): { value: Json; rest: Uint8Array } | { code: 'LimitExceeded' | 'HostUnavailable' | 'InvalidShape' } {
  if (bytes.length < 4) return { code: 'HostUnavailable' };
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (length === 0 || length > MAX_FRAME_BYTES) return { code: 'LimitExceeded' };
  if (bytes.length < length + 4) return { code: 'HostUnavailable' };
  try { return { value: JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4))) as Json, rest: bytes.subarray(length + 4) }; } catch { return { code: 'InvalidShape' }; }
}
