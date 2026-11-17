// Virtual machine, simulator and browser guests (`guests.control`, runtime phase R4, slice R0410).
//
// The native rules live in src-tauri/src/extensions/runtime_guests.rs; this file mirrors them with no I/O for the browser
// preview and the deterministic checks of tests/extensions-runtime-guests.spec.ts. `GuestsModel` is the twin of the native
// `handle` over fake guest adapters that record each operation and the capture destination. The window has no half here:
// the guests are driven natively (the built-in VM, Simulator and browser controllers), and an image never crosses the
// channel, only the path of a file in the package's own data directory.
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';

export const PERMISSION = 'guests.control';
export const KINDS = ['vm', 'simulator', 'browser'] as const;
export type Kind = (typeof KINDS)[number];
export const OPS = ['list', 'capture', 'input', 'control'] as const;
export const BROWSER_NAME = 'page';
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const KEPT_CAPTURES = 32;
export const MAX_INPUT_BYTES = 16 * 1024;
export const MAX_TEXT = 8192;
const VM_ACTIONS = ['click', 'double_click', 'right_click', 'middle_click', 'move', 'drag', 'scroll', 'type', 'key'];
const SIMULATOR_INPUTS = ['tap', 'longPress', 'swipe', 'type', 'button', 'key', 'tapLabel'];
const BROWSER_ACTIONS = ['read', 'click', 'type'];
export type { Refusal, Reply };

/** The control actions of a kind. `delete` is deliberately not one: deleting a VM stays in the VM panel. */
export const actions = (kind: string): readonly string[] => (kind === 'vm' ? ['start', 'stop', 'suspend'] : kind === 'simulator' ? ['boot', 'shutdown', 'light', 'dark'] : kind === 'browser' ? ['back', 'forward', 'reload', 'stop'] : []);

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (): Refusal => refuse('PermissionDenied', PERMISSION);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 200 && !/\p{Cc}/u.test(value);
const utf8 = (text: string) => new TextEncoder().encode(text).length;

export type Capabilities = { vm: boolean; simulator: boolean; browser: boolean };
export const supports = (caps: Capabilities, kind: string): boolean => (kind === 'vm' ? caps.vm : kind === 'simulator' ? caps.simulator : kind === 'browser' ? caps.browser : false);
export const reason = (kind: string): string => (kind === 'vm' ? 'Virtual machines need an Apple silicon Mac.' : kind === 'simulator' ? 'Simulators need macOS with Xcode.' : kind === 'browser' ? 'The browser guest needs the desktop window.' : 'Unknown guest kind.');

export type Request =
  | { op: 'list' }
  | { op: 'capture'; id: string }
  | { op: 'input'; id: string; input: Record<string, unknown> }
  | { op: 'control'; id: string; action: string };

/** Splits `<kind>:<name>`. A kind outside the three is a kind this platform lacks: `UnsupportedCapability`. */
export function splitId(id: string): { kind: Kind; name: string } | Refusal {
  if (!ident(id)) return refuse('InvalidShape');
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return refuse('InvalidShape');
  const kind = id.slice(0, at);
  return (KINDS as readonly string[]).includes(kind) ? { kind: kind as Kind, name: id.slice(at + 1) } : refuse('UnsupportedCapability');
}

const textFits = (value: unknown): boolean => (typeof value === 'string' ? utf8(value) <= MAX_TEXT : Array.isArray(value) ? value.every(textFits) : record(value) ? Object.values(value).every(textFits) : true);

/** Reads a call: `{op, id?, input?, action?}`. Nothing is looked up here. */
export function readRequest(raw: unknown): Request | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  const op = raw.op;
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return refuse('InvalidShape');
  const extra: readonly string[] = op === 'capture' ? ['id'] : op === 'input' ? ['id', 'input'] : op === 'control' ? ['id', 'action'] : [];
  if (Object.keys(raw).some(key => key !== 'op' && !extra.includes(key))) return refuse('InvalidShape');
  if (op === 'list') return { op };
  if (!ident(raw.id)) return refuse('InvalidShape');
  if (op === 'capture') return { op, id: raw.id };
  if (op === 'input') {
    if (!record(raw.input)) return refuse('InvalidShape');
    if (utf8(JSON.stringify(raw.input)) > MAX_INPUT_BYTES || !textFits(raw.input)) return refuse('LimitExceeded');
    return { op, id: raw.id, input: raw.input };
  }
  return typeof raw.action === 'string' && raw.action !== '' && raw.action.length <= 32 ? { op: 'control', id: raw.id, action: raw.action } : refuse('InvalidShape');
}

/** Checks the shape of an input for its kind (the native parsers check it again). */
export function checkInput(kind: Kind, input: Record<string, unknown>): Refusal | null {
  const [key, allowed] = kind === 'vm' ? ['action', VM_ACTIONS] : kind === 'simulator' ? ['kind', SIMULATOR_INPUTS] : ['action', BROWSER_ACTIONS];
  const name = input[key as string];
  return typeof name === 'string' && (allowed as string[]).includes(name) ? null : refuse('InvalidShape');
}

export type Guest = { kind: Kind; name: string; label: string; state: string; interactive: boolean };
export const guestId = (guest: Pick<Guest, 'kind' | 'name'>): string => `${guest.kind}:${guest.name}`;
export const guestValue = (guest: Guest): Json => ({ id: guestId(guest), kind: guest.kind, name: guest.label, state: guest.state, interactive: guest.interactive });
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

/** What a call may ask of the world: whether the package holds `guests.control` now. */
export type Checks = { granted: () => boolean };

/** The deterministic twin of the native `handle`: same order of checks, same refusals, over fake guests that record every
 * operation. `files` is the package's data directory (path to bytes); a reply never carries those bytes. */
export class GuestsModel {
  readonly guests = new Map<string, Guest>();
  /** Every operation the guests received, in order: `capture:<id>`, `input:<id>:<json>`, `control:<id>:<action>`. */
  readonly log: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  /** The paths written, oldest first. */
  private written: string[] = [];
  private serial = 0;
  readonly caps: Capabilities;
  readonly dataDir: string;
  constructor(caps: Capabilities, dataDir = '/data/sample.runtime-guests/global') { this.caps = caps; this.dataDir = dataDir; }

  add(guest: Guest): void { this.guests.set(guestId(guest), guest); }
  private of(kind: Kind): Guest[] { return [...this.guests.values()].filter(guest => guest.kind === kind); }

  private find(id: string): Guest | Refusal {
    const split = splitId(id);
    if (isRefusal(split)) return split;
    if (!supports(this.caps, split.kind)) return refuse('UnsupportedCapability');
    return this.of(split.kind).find(guest => guest.name === split.name) ?? refuse('NotFound');
  }

  /** `panda.guests.*`. `between` runs after the guest was found and before it is touched (the spec revokes there). */
  call(checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Json> {
    if (!checks.granted()) return envelope(denied());
    const request = readRequest(raw);
    if (isRefusal(request)) return envelope(request);
    if (request.op === 'list') {
      const kinds: Json[] = [], guests: Json[] = [];
      for (const kind of KINDS) {
        if (!supports(this.caps, kind)) { kinds.push({ kind, supported: false, reason: reason(kind) }); continue; }
        kinds.push({ kind, supported: true });
        for (const guest of this.of(kind)) guests.push(guestValue(guest));
      }
      return { ok: true, value: { schemaVersion: 1, kinds, guests } };
    }
    const guest = this.find(request.id);
    if (isRefusal(guest)) return envelope(guest);
    if (request.op === 'control') {
      if (!actions(guest.kind).includes(request.action)) return envelope(refuse('InvalidShape'));
    } else {
      if (request.op === 'input') { const bad = checkInput(guest.kind, request.input); if (bad) return envelope(bad); }
      if (!guest.interactive) return envelope(refuse('Conflict'));
    }
    between();
    if (!checks.granted()) return envelope(denied());
    const id = guestId(guest);
    if (request.op === 'control') { this.log.push(`control:${id}:${request.action}`); this.builtin(id, request.action); return { ok: true, value: null }; }
    if (request.op === 'input') { this.log.push(`input:${id}:${JSON.stringify(request.input)}`); return { ok: true, value: { schemaVersion: 1, result: 'done' } }; }
    this.log.push(`capture:${id}`);
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index % 251);
    const path = `${this.dataDir}/guests/${guest.kind}-${++this.serial}.${guest.kind === 'vm' ? 'jpg' : 'png'}`;
    this.files.set(path, bytes); this.written.push(path);
    while (this.written.length > KEPT_CAPTURES) this.files.delete(this.written.shift()!);
    // A revoke while the image was taken removes it.
    if (!checks.granted()) { this.files.delete(path); this.written.pop(); return envelope(denied()); }
    return { ok: true, value: { schemaVersion: 1, id, kind: guest.kind, path, mime: guest.kind === 'vm' ? 'image/jpeg' : 'image/png', bytes: bytes.length, width: 4, height: 2 } };
  }

  /** What the built-in panels do, with no package involved: it never needs the permission and works in safe mode. */
  builtin(id: string, action: string): boolean {
    const guest = this.guests.get(id);
    if (!guest || !actions(guest.kind).includes(action)) return false;
    if (action === 'start' || action === 'boot') { guest.state = 'running'; guest.interactive = true; }
    else if (action === 'stop' || action === 'suspend' || action === 'shutdown') { guest.state = 'stopped'; guest.interactive = false; }
    return true;
  }
}
