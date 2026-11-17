/**
 * Panel instances and the panel-service channel (R0303, ADR-0001, contract G1/G2): the browser twin of
 * `runtime_service_lifetime::runtime_rich_channel` and the preview's transport.
 *
 * PREVIEW EVIDENCE, NOT NATIVE. `PanelChannel` mirrors the native rules (instance identity, visibility, state,
 * the 256 KiB and 20-per-second bounds, service-only calls, pending messages dropped on close) so the specs check the
 * same answers; `PreviewPanelHost` connects embedded shells of the browser preview by `postMessage` instead of the
 * native `POST /~panda/channel` and `Webview::eval`. Nothing here reaches native code. The bounds are for the
 * responsiveness and stability of the main window, never for trust (ADR-0005).
 *
 * Imports are pure at module load (the Node specs import this file); the app-only parts load their modules lazily.
 */

import type { Json } from './contracts';
export type { Json };
export const PERMISSION = 'ui.richViews';
export const MESSAGE_LIMIT = 256 * 1024;
export const STATE_LIMIT = 256 * 1024;
export const BODY_LIMIT = MESSAGE_LIMIT + 16 * 1024;
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 2000;
export const OUTBOX_LIMIT = 64;
export const DORMANT_LIMIT = 64;
export const CHANNEL_PATH = '/~panda/channel';
export const HOST_EVENT = 'panda-view-host';
export const SERVICE_ONLY = ['secrets', 'auth', 'internal', 'events', 'hooks', 'modelTools', 'commands', 'views', 'providers'] as const;
export const TOO_FAST = 'LimitExceeded: at most 20 panel messages per second per package in each direction (averaged over 2 s). Batch updates into fewer messages or send them less often.';
export const NO_SERVICE = 'UnsupportedCapability: this package has no background service to receive panel messages. Use pandaView.panda for host calls.';
export const NOT_RUNNING = "HostUnavailable: the package's service is not running. Try again when it has started.";
export const CLOSED = 'StaleContext: this panel instance was closed.';

export const serviceOnly = (path: string) => (SERVICE_ONLY as readonly string[]).includes(path.split('.')[0]) || path === 'storage.directory';
export const unsupportedInPanel = (path: string) => `UnsupportedCapability: ${path} is a service-only call. Secrets, sign-in, the data directory, internal calls and handler registrations stay in the package's service.`;
export function bytes(value: unknown): number {
  try { const text = JSON.stringify(value); return text === undefined ? Infinity : new TextEncoder().encode(text).length; } catch { return Infinity; }
}
export const tooLarge = (what: string, size: number) => `LimitExceeded: ${what} is at most 256 KiB of JSON (this one is ${size} bytes). Send larger data in chunks.`;
export const validPath = (path: string) => path.length <= 64 && /^[A-Za-z]+(\.[A-Za-z]+){1,2}$/.test(path);

/** A refusal: the code (what the SDK raises) and the actionable sentence beside it. */
export type Envelope = { ok: true; value: unknown } | { ok: false; error: { schemaVersion: 1; code: string; message: string; path: '$'; ids: string[] } };
export function refusal(error: string): Envelope { return { ok: false, error: { schemaVersion: 1, code: error.split(':')[0] || 'HostUnavailable', message: error, path: '$', ids: [] } }; }
const ok = (value: unknown): Envelope => ({ ok: true, value });
/** The error a panel or the preview service sees: `code` for the program, `message` for the person. */
export class ChannelError extends Error {
  readonly code: string;
  constructor(message: string) { super(message); this.name = 'ChannelError'; this.code = message.split(':')[0] || 'HostUnavailable'; }
}

/** Twin of `Rate`: at most `RATE_LIMIT * 2` messages in any two seconds. */
export class Rate {
  private times: number[] = [];
  admit(now: number): boolean {
    while (this.times.length && now - this.times[0] >= RATE_WINDOW_MS) this.times.shift();
    if (this.times.length >= RATE_LIMIT * (RATE_WINDOW_MS / 1000)) return false;
    this.times.push(now); return true;
  }
}

export type Placement = 'inspector' | 'window';
export type PanelInstance = { readonly instanceId: string; readonly viewId: string; readonly windowId: string; readonly placement: Placement; readonly visible: boolean; readonly focused: boolean };
export type Origin = { owner: string; version: string; viewId: string };
export function placementOf(label: string): [Placement, string] | undefined {
  if (label.startsWith('extension-panel-')) return ['inspector', 'main'];
  if (label.startsWith('extension-view-')) return ['window', label];
  return undefined;
}
const sameOrigin = (a: Origin, b: Origin) => a.owner === b.owner && a.version === b.version && a.viewId === b.viewId;

type Instance = {
  id: string; origin: Origin; placement: Placement; windowId: string; slot?: string;
  label?: string; session: string; ready: boolean; announced: boolean; visible: boolean; focused: boolean;
  state?: Json; outbox: Record<string, unknown>[]; seen: number;
};
const publicOf = (instance: Instance): PanelInstance => ({ instanceId: instance.id, viewId: instance.origin.viewId, windowId: instance.windowId, placement: instance.placement, visible: instance.visible, focused: instance.focused });
export type PanelEvent = { kind: 'opened' | 'visible' | 'hidden' | 'closed'; viewId: string; instance: PanelInstance };
export type ServiceParams = PanelEvent | { kind: 'message'; viewId: string; message: Json; instance: PanelInstance };
export type Out = { kind: 'panel'; label: string; message: Record<string, unknown> } | { kind: 'service'; owner: string; params: ServiceParams };
const event = (kind: PanelEvent['kind'], instance: Instance): Out => ({ kind: 'service', owner: instance.origin.owner, params: { kind, viewId: instance.origin.viewId, instance: publicOf(instance) } });
const push = (instance: Instance, message: Record<string, unknown>): Out[] => instance.label ? [{ kind: 'panel', label: instance.label, message: { ...message, schemaVersion: 1, session: instance.session } }] : [];

export type Init = { instanceId: string; viewId: string; placement: Placement; restored: boolean; visible: boolean; pending: Record<string, unknown>[]; state?: Json; theme?: unknown };

/** Twin of the native `Channel`. Pure: effects are returned as `Out`. */
export class PanelChannel {
  private instances = new Map<string, Instance>();
  private labels = new Map<string, string>();
  private rates = new Map<string, Rate>();
  private theme: unknown;
  private clock = 0;

  private rate(owner: string, direction: 'toService' | 'toPanel', now: number): boolean {
    const key = `${owner}\u0000${direction}`;
    let rate = this.rates.get(key);
    if (!rate) { rate = new Rate(); this.rates.set(key, rate); }
    return rate.admit(now);
  }
  private live(label: string): Instance {
    const id = this.labels.get(label), instance = id === undefined ? undefined : this.instances.get(id);
    if (!instance || instance.label !== label) throw new ChannelError(CLOSED);
    return instance;
  }

  hello(label: string, session: string, origin: Origin): { init: Init; outs: Out[] } {
    const where = placementOf(label);
    if (!where) throw new ChannelError('PermissionDenied');
    const [placement, windowId] = where;
    this.clock += 1;
    let id = this.labels.get(label), restored = false;
    if (id !== undefined && this.instances.get(id) && sameOrigin(this.instances.get(id)!.origin, origin)) restored = true;
    else {
      if (id !== undefined) { this.instances.delete(id); this.labels.delete(label); }
      const slot = placement === 'inspector' ? `${windowId}:${origin.viewId}` : undefined;
      const dormant = slot === undefined ? undefined : [...this.instances.values()].find(instance => !instance.label && instance.slot === slot && sameOrigin(instance.origin, origin));
      if (dormant) { id = dormant.id; restored = true; }
      else {
        id = crypto.randomUUID();
        this.instances.set(id, { id, origin, placement, windowId, slot, session: '', ready: false, announced: false, visible: true, focused: false, outbox: [], seen: 0 });
      }
    }
    this.labels.set(label, id);
    const instance = this.instances.get(id)!;
    const opened = !instance.announced;
    if (instance.label !== label) { instance.visible = true; instance.focused = false; }
    Object.assign(instance, { label, session, ready: true, announced: true, seen: this.clock });
    const pending = instance.outbox.splice(0);
    const init: Init = { instanceId: instance.id, viewId: origin.viewId, placement, restored, visible: instance.visible, pending };
    if (instance.state !== undefined) init.state = instance.state;
    if (this.theme !== undefined) init.theme = this.theme;
    return { init, outs: opened ? [event('opened', instance)] : [] };
  }
  bye(label: string) { try { this.live(label).ready = false; } catch { /* already closed */ } }
  setState(label: string, value: Json) {
    const size = bytes(value);
    if (size > STATE_LIMIT) throw new ChannelError(tooLarge('pandaView.state', size));
    this.live(label).state = structuredClone(value);
  }
  setFocus(label: string, focused: boolean) { this.live(label).focused = focused; }
  fromPanel(label: string, message: Json, now: number): { owner: string; params: ServiceParams } {
    const size = bytes(message);
    if (size > MESSAGE_LIMIT) throw new ChannelError(tooLarge('A panel message', size));
    const instance = this.live(label);
    if (!this.rate(instance.origin.owner, 'toService', now)) throw new ChannelError(TOO_FAST);
    return { owner: instance.origin.owner, params: { kind: 'message', viewId: instance.origin.viewId, message: structuredClone(message), instance: publicOf(instance) } };
  }
  call(label: string, path: string): Origin {
    const origin = this.live(label).origin;
    if (serviceOnly(path)) throw new ChannelError(unsupportedInPanel(path));
    return origin;
  }
  reply(label: string, session: string, id: number, envelope: Envelope): Out[] {
    let instance: Instance;
    try { instance = this.live(label); } catch { return []; }
    if (instance.session !== session) return [];
    return push(instance, envelope.ok ? { kind: 'reply', id, ok: true, value: envelope.value ?? null } : { kind: 'reply', id, ok: false, error: envelope.error });
  }
  detach(label: string, keep: boolean): Out[] {
    const id = this.labels.get(label);
    if (id === undefined) return [];
    this.labels.delete(label);
    const instance = this.instances.get(id);
    if (!instance || instance.label !== label) return [];
    Object.assign(instance, { label: undefined, ready: false, focused: false, visible: false, outbox: [] });
    const outs = instance.announced ? [event('closed', instance)] : [];
    instance.announced = false;
    if (!keep || instance.slot === undefined) this.instances.delete(id);
    this.trim();
    return outs;
  }
  private trim() {
    const dormant = [...this.instances.values()].filter(instance => !instance.label).sort((a, b) => a.seen - b.seen);
    for (const instance of dormant.slice(0, Math.max(0, dormant.length - DORMANT_LIMIT))) this.instances.delete(instance.id);
  }
  setVisible(label: string, visible: boolean): Out[] {
    let instance: Instance;
    try { instance = this.live(label); } catch { return []; }
    if (instance.visible === visible) return [];
    instance.visible = visible;
    if (!instance.announced) return [];
    return [event(visible ? 'visible' : 'hidden', instance), ...(instance.ready ? push(instance, { kind: 'visibility', visible }) : [])];
  }
  toPanels(owner: string, viewId: string, message: Json, target: string | undefined, now: number): { delivered: number; outs: Out[] } {
    const size = bytes(message);
    if (size > MESSAGE_LIMIT) throw new ChannelError(tooLarge('A panel message', size));
    if (!this.rate(owner, 'toPanel', now)) throw new ChannelError(TOO_FAST);
    let delivered = 0; const outs: Out[] = [];
    for (const instance of this.instances.values()) {
      if (instance.origin.owner !== owner || instance.origin.viewId !== viewId || !instance.label || (target !== undefined && target !== instance.id)) continue;
      if (instance.ready) { outs.push(...push(instance, { kind: 'message', message: structuredClone(message) })); delivered += 1; }
      else if (instance.outbox.length < OUTBOX_LIMIT) { instance.outbox.push({ kind: 'message', message: structuredClone(message) }); delivered += 1; }
    }
    return { delivered, outs };
  }
  list(owner: string, viewId?: string): PanelInstance[] {
    return [...this.instances.values()].filter(instance => instance.origin.owner === owner && instance.label && (viewId === undefined || instance.origin.viewId === viewId)).map(publicOf);
  }
  setTheme(theme: unknown): Out[] {
    this.theme = theme;
    return [...this.instances.values()].filter(instance => instance.ready).flatMap(instance => push(instance, { kind: 'theme', theme }));
  }
  purge(allowed: (origin: Origin) => boolean) { for (const [id, instance] of this.instances) if (!instance.label && !allowed(instance.origin)) this.instances.delete(id); }
  dormant() { return [...this.instances.values()].filter(instance => !instance.label).length; }
}

/** One shell request, parsed against its session (twin of `parse`): closed shapes, so `invoke` or `command` is none. */
export type Request = { kind: 'hello' } | { kind: 'bye' } | { kind: 'post'; id: number; message: Json } | { kind: 'state'; value: Json } | { kind: 'focus'; focused: boolean } | { kind: 'call'; id: number; path: string; args: Json[] };
const SHAPES: Record<string, string> = {
  hello: 'kind,schemaVersion,session', bye: 'kind,schemaVersion,session', post: 'id,kind,message,schemaVersion,session',
  state: 'kind,schemaVersion,session,value', focus: 'focused,kind,schemaVersion,session', call: 'args,id,kind,path,schemaVersion,session',
};
export function parseRequest(raw: unknown, session: string): Request {
  if (bytes(raw) > BODY_LIMIT) throw new ChannelError(tooLarge('A panel request', bytes(raw)));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ChannelError('InvalidShape');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.session !== session || typeof value.kind !== 'string' || !Object.hasOwn(SHAPES, value.kind) || Object.keys(value).sort().join(',') !== SHAPES[value.kind]) throw new ChannelError('InvalidShape');
  const id = () => { if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) throw new ChannelError('InvalidShape'); return value.id as number; };
  switch (value.kind) {
    case 'hello': return { kind: 'hello' };
    case 'bye': return { kind: 'bye' };
    case 'post': return { kind: 'post', id: id(), message: value.message as Json };
    case 'state': return { kind: 'state', value: value.value as Json };
    case 'focus': if (typeof value.focused !== 'boolean') throw new ChannelError('InvalidShape'); return { kind: 'focus', focused: value.focused };
    default:
      if (typeof value.path !== 'string' || !validPath(value.path) || !Array.isArray(value.args) || value.args.length > 4) throw new ChannelError('InvalidShape');
      return { kind: 'call', id: id(), path: value.path, args: value.args as Json[] };
  }
}

const TOKENS = ['--bg', '--text', '--accent', '--focus', '--muted', '--panel', '--ds-radius-card', '--ds-row-pad-y'];
const TOKEN = /^(#[0-9a-fA-F]{6}|[0-9]{1,2}px)$/;
/** Twin of `valid_theme`: the finite theme of `rich-view-channel.js`. */
export function validTheme(theme: unknown): boolean {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return false;
  const value = theme as Record<string, unknown>, keys = Object.keys(value).sort().join(',');
  if (keys !== 'colorScheme,schemaVersion' && keys !== 'colorScheme,schemaVersion,tokens') return false;
  if (value.schemaVersion !== 1 || (value.colorScheme !== 'dark' && value.colorScheme !== 'light')) return false;
  if (value.tokens === undefined) return true;
  const tokens = value.tokens;
  return !!tokens && typeof tokens === 'object' && !Array.isArray(tokens) && Object.keys(tokens).length <= 16
    && Object.entries(tokens).every(([key, token]) => TOKENS.includes(key) && typeof token === 'string' && TOKEN.test(token));
}
/** The app's appearance as a valid panel theme: tokens the finite schema cannot carry are left out. */
export function themeFrom(snapshot: { colorScheme: string; tokens?: Record<string, string> }): { schemaVersion: 1; colorScheme: 'dark' | 'light'; tokens: Record<string, string> } {
  const tokens = Object.fromEntries(Object.entries(snapshot.tokens ?? {}).filter(([key, token]) => TOKENS.includes(key) && TOKEN.test(token)));
  return { schemaVersion: 1, colorScheme: snapshot.colorScheme === 'dark' ? 'dark' : 'light', tokens };
}

/** What the preview host needs of a service: whether it runs, its panel handlers, and its SDK by path. */
export interface PanelService {
  declares(owner: string): boolean;
  running(owner: string): boolean;
  /** A message or event for the service's `views` handlers (the native host call `panel`). */
  deliver(owner: string, params: ServiceParams): Promise<void>;
  /** A proxied SDK call of a panel (never a service-only one). */
  call(owner: string, path: string, args: Json[]): Promise<unknown>;
}

type Bound = { frame: { readonly contentWindow: Window | null }; origin: Origin; session?: string };
/**
 * The preview's host of embedded shells: a shell posts `{ kind: 'channel', seq, request }` to this page and gets
 * `{ kind: 'channel-reply', seq, response }`; pushes arrive as `{ kind: 'host', detail }`. The source window is the
 * identity (never a field of the request), as the native label is.
 */
export class PreviewPanelHost {
  readonly channel = new PanelChannel();
  private bound = new Map<string, Bound>();
  private service: PanelService | undefined;
  private listening = false;
  constructor(private now: () => number = () => performance.now()) {}

  setService(service: PanelService | undefined) { this.service = service; }
  /** Connects the shell in `frame` as mount `label`; the returned disposal closes the instance (keeping its state). */
  bind(label: string, frame: { readonly contentWindow: Window | null }, origin: Origin): (keep?: boolean) => void {
    this.listen();
    this.bound.set(label, { frame, origin });
    return (keep = true) => { this.bound.delete(label); this.deliver(this.channel.detach(label, keep)); };
  }
  setVisible(label: string, visible: boolean) { this.deliver(this.channel.setVisible(label, visible)); }
  setTheme(theme: unknown) { if (validTheme(theme)) this.deliver(this.channel.setTheme(theme)); }
  /** `panda.views.post` of the preview service. */
  post(owner: string, viewId: string, message: Json, instance?: string): { delivered: number } {
    const { delivered, outs } = this.channel.toPanels(owner, viewId, message, instance, this.now());
    this.deliver(outs);
    return { delivered };
  }
  instances(owner: string, viewId?: string) { return this.channel.list(owner, viewId); }
  /** One request of the shell bound as `label` (what the page's message listener does for an embedded shell). */
  handle(label: string, raw: unknown): Envelope {
    const bound = this.bound.get(label);
    return bound ? this.serve(label, bound, raw) : refusal(CLOSED);
  }

  private listen() {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('message', event => {
      const data = event.data as { schemaVersion?: unknown; kind?: unknown; seq?: unknown; request?: unknown } | null;
      if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || data.kind !== 'channel' || !Number.isSafeInteger(data.seq)) return;
      const entry = [...this.bound.entries()].find(([, bound]) => bound.frame.contentWindow === event.source);
      if (!entry) return;
      const [label, bound] = entry;
      const response = this.serve(label, bound, data.request);
      (event.source as Window).postMessage({ schemaVersion: 1, kind: 'channel-reply', seq: data.seq, response }, '*');
    });
  }
  private deliver(outs: Out[]) {
    for (const out of outs) {
      if (out.kind === 'panel') this.bound.get(out.label)?.frame.contentWindow?.postMessage({ schemaVersion: 1, kind: 'host', detail: out.message }, '*');
      else void this.service?.deliver(out.owner, out.params).catch(() => {});
    }
  }
  /** Twin of `serve_post`: answers at once; results of a message or a call arrive as a `reply` push. */
  private serve(label: string, bound: Bound, raw: unknown): Envelope {
    // The preview has no host-held session: the shell's first `hello` from this source window fixes it.
    const session = bound.session ?? (raw && typeof raw === 'object' ? String((raw as { session?: unknown }).session ?? '') : '');
    let request: Request;
    try { request = parseRequest(raw, session); } catch (error) { return refusal(String((error as Error).message)); }
    try {
      switch (request.kind) {
        case 'hello': {
          bound.session = session;
          const { init, outs } = this.channel.hello(label, session, bound.origin);
          this.deliver(outs);
          return ok(init);
        }
        case 'bye': this.channel.bye(label); return ok(null);
        case 'focus': this.channel.setFocus(label, request.focused); return ok(null);
        case 'state': this.channel.setState(label, request.value); return ok(null);
        case 'post': {
          const id = request.id;
          const { owner, params } = this.channel.fromPanel(label, request.message, this.now());
          const service = this.service;
          const answer = !service || !service.running(owner)
            ? Promise.resolve(refusal(service?.declares(owner) ? NOT_RUNNING : NO_SERVICE))
            : service.deliver(owner, params).then(() => ok(null), error => refusal(String((error as Error)?.message ?? 'HostUnavailable')));
          void answer.then(envelope => this.deliver(this.channel.reply(label, session, id, envelope)));
          return ok({ accepted: true });
        }
        case 'call': {
          const { id, path, args } = request;
          const origin = this.channel.call(label, path);
          const service = this.service;
          const answer = !service ? Promise.resolve(refusal(`UnsupportedCapability: ${path} has no preview host.`))
            : service.call(origin.owner, path, args).then(ok, error => refusal(String((error as { message?: string })?.message ?? (error as { code?: string })?.code ?? 'HostUnavailable')));
          void answer.then(envelope => this.deliver(this.channel.reply(label, session, id, envelope)));
          return ok({ accepted: true });
        }
      }
    } catch (error) { return refusal(String((error as Error).message)); }
  }
}

/**
 * The service side of the preview (`panda.views` of `runtime-preview.ts`): `post` and `instances` go to the host;
 * `onMessage` and `on` keep handlers here and receive what the host delivers, as `node-host.cjs` does.
 */
export class PreviewViews {
  private messages = new Map<string, Set<(message: Json, from: PanelInstance) => unknown>>();
  private events = new Map<string, Set<(instance: PanelInstance) => unknown>>();
  readonly faults: string[] = [];
  constructor(private host: PreviewPanelHost, private owner: string, private granted: () => boolean) {}
  private check() { if (!this.granted()) throw new ChannelError('PermissionDenied'); }
  post(viewId: string, message: Json, options?: { instance?: string }): Promise<{ delivered: number }> {
    return new Promise(resolve => { this.check(); resolve(this.host.post(this.owner, viewId, message, options?.instance)); });
  }
  instances(viewId?: string): Promise<PanelInstance[]> { return new Promise(resolve => { this.check(); resolve(this.host.instances(this.owner, viewId)); }); }
  onMessage(viewId: string, handler: (message: Json, from: PanelInstance) => unknown): { dispose(): void } {
    const set = this.messages.get(viewId) ?? new Set(); this.messages.set(viewId, set); set.add(handler);
    return { dispose: () => { set.delete(handler); } };
  }
  on(kind: PanelEvent['kind'], handler: (instance: PanelInstance) => unknown): { dispose(): void } {
    if (!['opened', 'visible', 'hidden', 'closed'].includes(kind)) throw new ChannelError('InvalidShape');
    const set = this.events.get(kind) ?? new Set(); this.events.set(kind, set); set.add(handler);
    return { dispose: () => { set.delete(handler); } };
  }
  /** One host call `panel`: every handler, in order; a failing handler never stops the next message. */
  async receive(params: ServiceParams): Promise<void> {
    const handlers = params.kind === 'message' ? [...(this.messages.get(params.viewId) ?? [])].map(handler => () => handler(params.message, params.instance))
      : [...(this.events.get(params.kind) ?? [])].map(handler => () => handler(params.instance));
    for (const run of handlers) { try { await run(); } catch (error) { this.faults.push(String(error)); } }
  }
  clear() { this.messages.clear(); this.events.clear(); }
}

// ---- the app ----------------------------------------------------------------------------------------------------

let previewHost: PreviewPanelHost | undefined;
/** The preview page's one host of embedded panel shells. */
export function previewPanelHost(): PreviewPanelHost { return (previewHost ??= new PreviewPanelHost()); }

let following = false;
/** The event the main window emits with its appearance (twin of `runtime_rich_channel::THEME_EVENT`). */
export const THEME_EVENT = 'extensions-rich-channel-theme';
/**
 * Panels follow the app's appearance: installed, through `THEME_EVENT` (only the main window may emit; the host checks
 * the finite theme before any panel sees it); in the preview, through the page's host.
 */
export function followTheme() {
  if (following || typeof window === 'undefined') return;
  following = true;
  const send = async () => {
    const [{ preview }, { appearanceSnapshot }] = await Promise.all([import('../bridge'), import('./rich-views')]);
    const theme = themeFrom(appearanceSnapshot());
    if (preview) { previewPanelHost().setTheme(theme); return; }
    const { emit } = await import('@tauri-apps/api/event');
    await emit(THEME_EVENT, theme).catch(() => {});
  };
  window.addEventListener('pandacode-palette-change', () => { void send(); });
  void send();
}
