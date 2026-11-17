// R1301: the granted unstable internal interface (`internal.unstable`, `panda.internal.invoke` / `listen`).
// The native rules live in src-tauri/src/extensions/runtime_internal_unstable.rs; this file mirrors them with no I/O for the browser
// preview and the deterministic checks of tests/extensions-runtime-internal-unstable.spec.ts. The interface is service only and
// carries NO compatibility promise: names, arguments and results change with any release or upstream merge.

export const PERMISSION = 'internal.unstable';
export const ARGS_BYTES = 64 * 1024;
export const MAX_LISTENERS = 16;
export const MAX_QUEUE = 64;
export const MAX_ACTIVITY = 200;
export const TICK_MS = 100;
/** The host operations and events a service may reach. Inert; a host module that wants to be reachable adds a row. */
export const COMMANDS: readonly string[] = ['internal.info', 'internal.echo'];
export const EVENTS: readonly string[] = ['internal.echoed'];
/** Fragments that mark a name as holding a credential (ADR-0006). */
export const RESERVED: readonly string[] = ['secret', 'credential', 'token', 'password', 'keychain', 'oauth', 'signin', 'privatekey'];
const OPS = ['invoke', 'listen', 'poll', 'unlisten'] as const;

export interface Refusal { readonly ok: false; readonly error: { readonly code: string; readonly path: string } }
export type Reply = { readonly ok: true; readonly value: unknown } | Refusal;
const refuse = (code: string, path = '$'): Refusal => ({ ok: false, error: { code, path } });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);

export const nameOk = (name: unknown): name is string => typeof name === 'string' && /^[a-z][a-z0-9._:-]{0,63}$/.test(name);
/** Whether `name` denotes something that holds a credential; separators and case are ignored. */
export function reserved(name: string): boolean {
  const folded = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return RESERVED.some(part => folded.includes(part));
}

export type Request =
  | { readonly op: 'invoke'; readonly command: string; readonly args: unknown }
  | { readonly op: 'listen'; readonly event: string }
  | { readonly op: 'poll' | 'unlisten'; readonly listener: string };

export function opOf(raw: unknown): string | Refusal {
  const op = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).op : undefined;
  return typeof op === 'string' && (OPS as readonly string[]).includes(op) ? op : refuse('InvalidShape');
}

/** Reads a call; nothing is looked up here. */
export function readRequest(raw: unknown): Request | Refusal {
  const op = opOf(raw);
  if (typeof op !== 'string') return op;
  const object = raw as Record<string, unknown>;
  const allowed = op === 'invoke' ? ['command', 'args'] : op === 'listen' ? ['event'] : ['listenerId'];
  if (Object.keys(object).some(key => key !== 'op' && !allowed.includes(key))) return refuse('InvalidShape');
  if (op === 'invoke') {
    if (!nameOk(object.command)) return refuse('InvalidShape');
    const args = object.args ?? null;
    if (JSON.stringify(args).length > ARGS_BYTES) return refuse('LimitExceeded');
    return { op, command: object.command, args };
  }
  if (op === 'listen') return nameOk(object.event) ? { op, event: object.event } : refuse('InvalidShape');
  const id = object.listenerId;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? { op: op as 'poll' | 'unlisten', listener: id } : refuse('InvalidShape');
}

/** The grant answers first (a package without it learns nothing about names), then the credential rule, then the table. */
export function gate(holds: boolean, table: readonly string[], name: string): Refusal | null {
  if (!holds) return denied();
  if (reserved(name)) return refuse('PermissionDenied', 'credentials');
  return table.includes(name) ? null : refuse('NotFound');
}

export interface ActivityLine { readonly at: number; readonly package: string; readonly op: string; readonly name: string; readonly outcome: string; readonly stability: 'unstable' }
/** What the host says about a package at call time. `service` is false for a panel caller. */
export interface Checks { readonly holds: boolean; readonly service?: boolean }
interface Listener { readonly owner: string; readonly event: string; queue: unknown[]; dropped: number }

/** The deterministic host: listeners, queues and the activity list, as the native state keeps them. */
export class InternalModel {
  readonly listeners = new Map<string, Listener>();
  private readonly lists = new Map<string, ActivityLine[]>();
  private serial = 0;
  private clock = 0;

  activity(owner: string): readonly ActivityLine[] { return this.lists.get(owner) ?? []; }
  count(owner: string): number { return [...this.listeners.values()].filter(listener => listener.owner === owner).length; }
  private record(owner: string, op: string, name: string, outcome: string): void {
    const list = this.lists.get(owner) ?? [];
    list.push({ at: ++this.clock, package: owner, op, name: name.slice(0, 64), outcome, stability: 'unstable' });
    while (list.length > MAX_ACTIVITY) list.shift();
    this.lists.set(owner, list);
  }
  /** The host raised `event`: every listener of it queues a copy, the oldest going first past 64. */
  publish(event: string, payload: unknown): number {
    let queued = 0;
    for (const listener of this.listeners.values()) {
      if (listener.event !== event) continue;
      if (listener.queue.length >= MAX_QUEUE) { listener.queue.shift(); listener.dropped += 1; }
      listener.queue.push(payload); queued += 1;
    }
    return queued;
  }
  /** Disable, revoke, untrust, safe mode and the service's end: every listener of the package goes. */
  dropListeners(owner: string): number {
    let gone = 0;
    for (const [id, listener] of [...this.listeners]) if (listener.owner === owner) { this.listeners.delete(id); gone += 1; }
    return gone;
  }
  /** One call of `owner`. A panel is refused with `UnsupportedCapability` before anything else. */
  call(owner: string, checks: Checks, raw: unknown): Reply {
    if (checks.service === false) return refuse('UnsupportedCapability', 'internal');
    const request = readRequest(raw);
    if ('ok' in request) return request;
    if (request.op === 'unlisten') { if (this.listeners.get(request.listener)?.owner === owner) this.listeners.delete(request.listener); return { ok: true, value: null }; }
    if (!checks.holds) { this.dropListeners(owner); const refusal = denied(); if (request.op !== 'poll') this.record(owner, request.op, request.op === 'invoke' ? request.command : request.op === 'listen' ? request.event : '', refusal.error.code); return refusal; }
    if (request.op === 'invoke') {
      const refusal = gate(true, COMMANDS, request.command);
      this.record(owner, 'invoke', request.command, refusal ? refusal.error.code : 'ok');
      if (refusal) return refusal;
      if (request.command === 'internal.info') return { ok: true, value: { schemaVersion: 1, stability: 'unstable', commands: COMMANDS, events: EVENTS } };
      this.publish('internal.echoed', request.args);
      return { ok: true, value: { echo: request.args } };
    }
    if (request.op === 'listen') {
      const refusal = gate(true, EVENTS, request.event);
      this.record(owner, 'listen', request.event, refusal ? refusal.error.code : this.count(owner) >= MAX_LISTENERS ? 'LimitExceeded' : 'ok');
      if (refusal) return refusal;
      if (this.count(owner) >= MAX_LISTENERS) return refuse('LimitExceeded');
      const id = `${owner}#internal-${++this.serial}`;
      this.listeners.set(id, { owner, event: request.event, queue: [], dropped: 0 });
      return { ok: true, value: { listenerId: id, intervalMs: TICK_MS } };
    }
    const listener = this.listeners.get(request.listener);
    if (!listener || listener.owner !== owner) return refuse('NotFound');
    const events = listener.queue.splice(0); const dropped = listener.dropped; listener.dropped = 0;
    return { ok: true, value: { events, dropped, retryMs: TICK_MS } };
  }
}
