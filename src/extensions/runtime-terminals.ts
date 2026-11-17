// Read and operate terminals with separate grants (`terminals.read`, `terminals.write`, runtime phase R4, slice R0409).
//
// The native rules live in src-tauri/src/extensions/runtime_terminals.rs; this file mirrors them with no I/O for the browser
// preview and the deterministic checks of tests/extensions-runtime-terminals.spec.ts. `terminals.read` covers `list`, `read` and
// `onOutput`; `terminals.write` covers `open`, `write` and `close`. The grants are independent, project scoped, rechecked on every
// call and never asked again per action (ADR-0005). Output is paged in 64 KiB pages after a byte cursor and an `onOutput`
// subscription hands out at most one coalesced chunk per 100 ms, each starting exactly where the previous one ended.
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';

export const READ_PERMISSION = 'terminals.read';
export const WRITE_PERMISSION = 'terminals.write';
export const PAGE_BYTES = 64 * 1024;
export const INPUT_BYTES = 64 * 1024;
export const LOG_BYTES = 256 * 1024;
export const TICK_MS = 100;
export const MAX_SUBSCRIPTIONS = 16;
export const OPS = ['list', 'read', 'subscribe', 'poll', 'unsubscribe', 'open', 'write', 'close'] as const;
export type OpName = (typeof OPS)[number];
const MAX_OFFSET = 2 ** 53;

export type Request =
  | { op: 'list'; project?: string }
  | { op: 'read'; terminal: string; cursor: number }
  | { op: 'subscribe'; terminal: string; cursor?: number }
  | { op: 'poll'; subscription: string }
  | { op: 'unsubscribe'; subscription: string }
  | { op: 'open'; project: string; task?: string; cols: number; rows: number }
  | { op: 'write'; terminal: string; data: string }
  | { op: 'close'; terminal: string };
export type { Refusal, Reply };

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (permission: string): Refusal => refuse('PermissionDenied', permission);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

/** The grant an operation needs: `open`, `write` and `close` need `terminals.write`; everything else `terminals.read`. */
export const permissionFor = (op: string): string => (op === 'open' || op === 'write' || op === 'close' ? WRITE_PERMISSION : READ_PERMISSION);

const idField = (raw: Record<string, unknown>, key: string): string | undefined | Refusal => {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return ident(value) ? value : refuse('InvalidShape');
};
const needId = (raw: Record<string, unknown>, key: string): string | Refusal => {
  const value = idField(raw, key);
  return value === undefined ? refuse('InvalidShape') : value;
};
const offsetField = (raw: Record<string, unknown>, key: string): number | undefined | Refusal => {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_OFFSET ? value : refuse('InvalidShape');
};
const dimension = (raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number | Refusal => {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : refuse('InvalidShape');
};

/** Reads a call: `{op, ...fields}`. Nothing is looked up here. */
export function readRequest(raw: unknown): Request | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  const op = raw.op;
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return refuse('InvalidShape');
  const allowed: readonly string[] = op === 'list' ? ['projectId'] : op === 'read' || op === 'subscribe' ? ['terminalId', 'cursor'] : op === 'poll' || op === 'unsubscribe' ? ['subscriptionId'] : op === 'open' ? ['projectId', 'taskId', 'cols', 'rows'] : op === 'write' ? ['terminalId', 'data'] : ['terminalId'];
  if (Object.keys(raw).some(key => key !== 'op' && !allowed.includes(key))) return refuse('InvalidShape');
  const fail = (...values: unknown[]): Refusal | undefined => values.find(isRefusal) as Refusal | undefined;
  switch (op) {
    case 'list': { const project = idField(raw, 'projectId'); return isRefusal(project) ? project : project === undefined ? { op: 'list' } : { op: 'list', project }; }
    case 'read': { const terminal = needId(raw, 'terminalId'), cursor = offsetField(raw, 'cursor'); return fail(terminal, cursor) ?? { op: 'read', terminal: terminal as string, cursor: (cursor as number | undefined) ?? 0 }; }
    case 'subscribe': { const terminal = needId(raw, 'terminalId'), cursor = offsetField(raw, 'cursor'); return fail(terminal, cursor) ?? { op: 'subscribe', terminal: terminal as string, ...(cursor !== undefined ? { cursor: cursor as number } : {}) }; }
    case 'poll': case 'unsubscribe': { const subscription = needId(raw, 'subscriptionId'); return isRefusal(subscription) ? subscription : { op, subscription }; }
    case 'open': {
      const project = needId(raw, 'projectId'), task = idField(raw, 'taskId'), cols = dimension(raw, 'cols', 80, 10, 500), rows = dimension(raw, 'rows', 24, 2, 200);
      return fail(project, task, cols, rows) ?? { op: 'open', project: project as string, ...(task !== undefined ? { task: task as string } : {}), cols: cols as number, rows: rows as number };
    }
    case 'write': {
      const terminal = needId(raw, 'terminalId');
      if (isRefusal(terminal)) return terminal;
      if (typeof raw.data !== 'string' || raw.data === '') return refuse('InvalidShape');
      return new TextEncoder().encode(raw.data).length > INPUT_BYTES ? refuse('LimitExceeded') : { op: 'write', terminal, data: raw.data };
    }
    default: { const terminal = needId(raw, 'terminalId'); return isRefusal(terminal) ? terminal : { op: 'close', terminal }; }
  }
}

/** The grant for the project a call reaches. `holds` is "the package holds this permission for any project": without it the
 * answer is the permission itself whatever the target, so a refusal never says whether a terminal exists. */
export function gate(permission: string, holds: boolean, project: string | undefined, granted: (project: string) => boolean): string | Refusal {
  if (!holds) return denied(permission);
  if (project === undefined) return refuse('NotFound');
  return granted(project) ? project : denied(permission);
}

export type Listed = { id: string; title: string; cwd: string; sessionId: string | null; kind: string; running: boolean; exitCode: number | null };
export type Attribution = { owners: ReadonlyMap<string, string>; sessions: ReadonlyMap<string, string>; projects: readonly (readonly [string, string])[] };
const fold = (path: string): string => path.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '').toLowerCase();
const within = (cwd: string, root: string): boolean => { const [inner, outer] = [fold(cwd), fold(root)]; return outer !== '' && (inner === outer || inner.startsWith(`${outer.replace(/\/+$/, '')}/`)); };
/** The project of a terminal: opened by a package for it, opened for a task of it, or the longest project folder containing its cwd. */
export function attribute(attribution: Attribution, terminal: Listed): string | undefined {
  const owned = attribution.owners.get(terminal.id);
  if (owned !== undefined) return owned;
  const session = terminal.sessionId === null ? undefined : attribution.sessions.get(terminal.sessionId);
  if (session !== undefined) return session;
  return attribution.projects.filter(([, root]) => within(terminal.cwd, root)).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
}
export const terminalValue = (terminal: Listed, project: string): Json => ({ id: terminal.id, title: terminal.title, cwd: terminal.cwd, projectId: project, taskId: terminal.sessionId, kind: terminal.kind, running: terminal.running, exitCode: terminal.exitCode });

export type Page = { data: string; next: number; dropped: number; exited: boolean; exitCode: number | null };
/** `{schemaVersion, data, cursor, nextCursor, dropped, exited, exitCode}`: `cursor` is where `data` starts and `nextCursor` where the
 * next page does, so consecutive pages join without a gap or a repeat. */
export const pageValue = (page: Page): Json => ({ schemaVersion: 1, data: page.data, cursor: Math.max(0, page.next - new TextEncoder().encode(page.data).length), nextCursor: page.next, dropped: page.dropped, exited: page.exited, exitCode: page.exitCode });

const jsonCost = (character: string): number => {
  if ('"\\\n\r\t\b\f'.includes(character)) return 2;
  const code = character.codePointAt(0)!;
  return code < 0x20 ? 6 : new TextEncoder().encode(character).length;
};

/** The recorded output of one terminal, as `terminal.rs` keeps it: the last 256 KiB at monotonically increasing byte offsets. */
export class OutputLog {
  private bytes: number[] = [];
  start = 0;
  running = true;
  exitCode: number | null = null;
  readonly capacity: number;
  constructor(capacity = LOG_BYTES) { this.capacity = capacity; }
  get end(): number { return this.start + this.bytes.length; }
  push(text: string): void {
    for (const byte of new TextEncoder().encode(text)) this.bytes.push(byte);
    if (this.bytes.length <= this.capacity) return;
    let excess = this.bytes.length - this.capacity;
    while (excess < this.bytes.length && (this.bytes[excess] & 0xc0) === 0x80) excess += 1;
    this.bytes.splice(0, excess); this.start += excess;
  }
  exit(code: number | null): void { this.running = false; this.exitCode = code; }
  /** Output after `after`, at most `budget` bytes once JSON-escaped, cut at a character boundary. */
  read(after: number, budget = PAGE_BYTES): Page {
    const dropped = Math.max(0, this.start - after);
    let index = Math.min(Math.max(after, this.start), this.end) - this.start;
    while (index < this.bytes.length && (this.bytes[index] & 0xc0) === 0x80) index += 1;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(this.bytes.slice(index, index + budget)));
    let cost = 0, taken = '';
    for (const character of text) {
      if (character === '�') break;
      cost += jsonCost(character);
      if (cost > budget) break;
      taken += character;
    }
    const next = this.start + index + new TextEncoder().encode(taken).length;
    const exited = !this.running && next === this.end;
    return { data: taken, next, dropped, exited, exitCode: exited ? this.exitCode : null };
  }
}

type Sub = { owner: string; terminal: string; project: string; cursor: number; last: number | null };
type Terminal = { info: Listed; log: OutputLog; project: string | undefined; opener?: string };
/** What the world answers for a call: whether the package holds the permission at all, and for which project. */
export type Checks = { holds: boolean; granted: (projectId: string) => boolean };
/** The two grants answered separately, as the native side asks the grants file once per permission. A bare `Checks` answers both alike. */
export type Grants = { read: Checks; write: Checks };

/** The deterministic twin of the native `serve`: same order of checks, same refusals, same pages and the same coalescing. */
export class TerminalModel {
  readonly terminals = new Map<string, Terminal>();
  readonly subs = new Map<string, Sub>();
  readonly projects = new Set<string>();
  /** Everything a terminal was asked to do, in order: `open:<id>`, `write:<id>:<data>`, `close:<id>`. */
  readonly log: string[] = [];
  private serial = 0;
  private terminalSerial = 0;

  addProject(id: string): void { this.projects.add(id); }
  /** A terminal the user (or a task) already has. */
  add(id: string, project: string | undefined, kind = 'shell'): OutputLog {
    const log = new OutputLog();
    this.terminals.set(id, { info: { id, title: id, cwd: `/work/${project ?? 'none'}`, sessionId: null, kind, running: true, exitCode: null }, log, project });
    return log;
  }
  /** The shell prints: the log records it. */
  print(id: string, text: string): void { this.terminals.get(id)?.log.push(text); }
  exit(id: string, code: number | null): void { const terminal = this.terminals.get(id); if (!terminal) return; terminal.log.exit(code); terminal.info.running = false; terminal.info.exitCode = code; }
  count(owner: string): number { return [...this.subs.values()].filter(sub => sub.owner === owner).length; }
  handles(owner: string): number { return [...this.terminals.values()].filter(terminal => terminal.opener === owner).length; }
  /** The service ended: its subscriptions and handles go; the shells it opened stay for the user. */
  end(owner: string): number { let removed = 0; for (const [id, sub] of this.subs) if (sub.owner === owner) { this.subs.delete(id); removed += 1; } for (const terminal of this.terminals.values()) if (terminal.opener === owner) delete terminal.opener; return removed; }
  /** A grant changed: a subscription whose package no longer holds the read grant for its project goes. */
  sweep(holds: (owner: string, project: string) => boolean): number { let removed = 0; for (const [id, sub] of this.subs) if (!holds(sub.owner, sub.project)) { this.subs.delete(id); removed += 1; } return removed; }

  private locate(id: string, permission: string, checks: Checks): Terminal | Refusal {
    const terminal = this.terminals.get(id);
    const project = gate(permission, checks.holds, terminal?.project, checks.granted);
    return isRefusal(project) ? project : terminal!;
  }

  /** `panda.terminals.*`. `between` runs after the permission was checked and before the effect (a spec revokes there). `now` is milliseconds. */
  call(owner: string, grants: Checks | Grants, raw: unknown, now = 0, between: () => void = () => undefined): Reply<Json> {
    const name = record(raw) && typeof raw.op === 'string' ? raw.op : '';
    if (!(OPS as readonly string[]).includes(name)) return envelope(refuse('InvalidShape'));
    const permission = permissionFor(name);
    const checks: Checks = 'read' in grants ? (permission === READ_PERMISSION ? grants.read : grants.write) : grants;
    const request = readRequest(raw);
    // Stopping a subscription is cleanup, never a power: it needs no grant and cannot touch another package's.
    if (!isRefusal(request) && request.op === 'unsubscribe') { if (this.subs.get(request.subscription)?.owner === owner) this.subs.delete(request.subscription); return { ok: true, value: null }; }
    if (!checks.holds) {
      // A package that lost the read grant altogether has no listener left.
      if (permission === READ_PERMISSION) for (const [id, sub] of this.subs) if (sub.owner === owner) this.subs.delete(id);
      return envelope(denied(permission));
    }
    if (isRefusal(request)) return envelope(request);
    const fail = (refusal: Refusal) => envelope(refusal);
    switch (request.op) {
      case 'list': {
        if (request.project !== undefined) { const gated = gate(permission, true, request.project, checks.granted); if (isRefusal(gated)) return fail(gated); }
        const rows = [...this.terminals.values()].reverse().filter(terminal => terminal.project !== undefined && checks.granted(terminal.project) && (request.project === undefined || request.project === terminal.project));
        return { ok: true, value: rows.map(terminal => terminalValue(terminal.info, terminal.project!)) };
      }
      case 'read': {
        const terminal = this.locate(request.terminal, permission, checks);
        if (isRefusal(terminal)) return fail(terminal);
        between();
        if (!checks.granted(terminal.project!)) return fail(denied(permission));
        return { ok: true, value: pageValue(terminal.log.read(request.cursor)) };
      }
      case 'subscribe': {
        const terminal = this.locate(request.terminal, permission, checks);
        if (isRefusal(terminal)) return fail(terminal);
        if (this.count(owner) >= MAX_SUBSCRIPTIONS) return fail(refuse('LimitExceeded'));
        const cursor = request.cursor ?? terminal.log.end;
        const id = `${owner}#term-${++this.serial}`;
        this.subs.set(id, { owner, terminal: request.terminal, project: terminal.project!, cursor, last: null });
        return { ok: true, value: { subscriptionId: id, cursor, intervalMs: TICK_MS } };
      }
      case 'poll': {
        const sub = this.subs.get(request.subscription);
        if (!sub || sub.owner !== owner) return fail(refuse('NotFound'));
        if (!checks.granted(sub.project)) { this.subs.delete(request.subscription); return fail(denied(READ_PERMISSION)); }
        if (sub.last !== null && now < sub.last + TICK_MS) return { ok: true, value: { chunk: null, ended: false, retryMs: sub.last + TICK_MS - now } };
        const terminal = this.terminals.get(sub.terminal);
        if (!terminal) { this.subs.delete(request.subscription); return { ok: true, value: { chunk: null, ended: true, reason: 'closed' } }; }
        const page = terminal.log.read(sub.cursor);
        sub.cursor = page.next; sub.last = now;
        if (page.exited) this.subs.delete(request.subscription);
        const has = page.data !== '' || page.dropped > 0 || page.exited;
        return { ok: true, value: { chunk: has ? pageValue(page) : null, ended: page.exited, retryMs: TICK_MS } };
      }
      case 'open': {
        const project = gate(permission, true, this.projects.has(request.project) ? request.project : undefined, checks.granted);
        if (isRefusal(project)) return fail(project);
        between();
        if (!checks.granted(project)) return fail(denied(permission));
        const id = `term-${++this.terminalSerial}`;
        this.add(id, project);
        this.terminals.get(id)!.opener = owner;
        this.log.push(`open:${id}`);
        return { ok: true, value: { id, projectId: project, taskId: request.task ?? null } };
      }
      case 'write': {
        const terminal = this.locate(request.terminal, permission, checks);
        if (isRefusal(terminal)) return fail(terminal);
        between();
        if (!checks.granted(terminal.project!)) return fail(denied(permission));
        if (!terminal.info.running) return fail(refuse('NotFound'));
        this.log.push(`write:${request.terminal}:${request.data}`);
        return { ok: true, value: null };
      }
      default: {
        const terminal = this.locate(request.terminal, permission, checks);
        if (isRefusal(terminal)) return fail(terminal);
        between();
        if (!checks.granted(terminal.project!)) return fail(denied(permission));
        this.terminals.delete(request.terminal);
        for (const [id, sub] of this.subs) if (sub.terminal === request.terminal) this.subs.delete(id);
        this.log.push(`close:${request.terminal}`);
        return { ok: true, value: null };
      }
    }
  }
}
