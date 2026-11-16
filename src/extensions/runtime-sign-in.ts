/**
 * Browser sign-in for trusted packages (`auth.signIn`, runtime slice R0803): the webview's read projection and
 * controls of the native owner (`src-tauri/src/extensions/runtime_sign_in.rs`, IPC `extensions_sign_in`,
 * `extensions_sign_in_cancel`, `extensions_sign_in_paste`) and the synthetic preview of its rules.
 *
 * The webview sees which packages wait, with a title, a phase and the time left, so it can show the notice
 * "Waiting for sign-in: <package>" with Cancel (and "Paste the redirect address" when the package offered it). It
 * never sees a callback address: that carries the authorization code, and the native host returns it only to the
 * package's service. The browser preview runs no package code and has no listener, so its flows come from a test
 * hook, on a simulated clock and simulated ports; it follows the same rules as the native owner.
 */
import { call } from '../bridge';

export const SIGN_IN_PERMISSION = 'auth.signIn';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 900_000;
export const PASTE_WINDOW_MS = 120_000;
export type SignInPhase = 'waiting' | 'paste';
export type SignInFlow = { id: string; title: string; notice: string; phase: SignInPhase; manual: boolean; remainingMs: number; copyAddress: string | null };
export type SignInProjection = { schemaVersion: 1; available: boolean; flows: SignInFlow[] };
export type SignInOutcome =
  | { status: 'completed'; url: string; redirectUri: string; via: 'callback' | 'manual' }
  | { status: 'cancelled' } | { status: 'timeout' };
export const UNAVAILABLE_SIGN_IN: SignInProjection = Object.freeze({ schemaVersion: 1, available: false, flows: [] }) as SignInProjection;

const FLOW_FIELDS = ['id', 'title', 'notice', 'phase', 'manual', 'remainingMs', 'copyAddress'];
/** Strict reader: a shape this build does not know is unavailable, never partially trusted. */
export function parseSignIns(value: unknown): SignInProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || !Array.isArray(root.flows)) return UNAVAILABLE_SIGN_IN;
  for (const item of root.flows as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.notice !== 'string' || (item.phase !== 'waiting' && item.phase !== 'paste')
      || typeof item.manual !== 'boolean' || !Number.isInteger(item.remainingMs) || !(item.copyAddress === null || typeof item.copyAddress === 'string')
      || Object.keys(item).some(name => !FLOW_FIELDS.includes(name))) return UNAVAILABLE_SIGN_IN;
  }
  return root as SignInProjection;
}
export async function loadSignIns(): Promise<SignInProjection> {
  try { return parseSignIns(await call<unknown>('extensions_sign_in')); } catch { return UNAVAILABLE_SIGN_IN; }
}
/** The Cancel button of the notice: the waiting service call answers `cancelled` and the port is freed. */
export async function cancelSignIn(id: string): Promise<boolean> {
  try { return Boolean((await call<{ cancelled?: boolean }>('extensions_sign_in_cancel', { id }))?.cancelled); } catch { return false; }
}
/** The "Paste the redirect address" dialog: resolves the waiting call with `via: 'manual'`. Throws the native error code. */
export async function pasteSignIn(id: string, url: string): Promise<void> { await call('extensions_sign_in_paste', { id, url }); }
/** What the notice says and offers for one flow. */
export function noticeOf(flow: SignInFlow): { text: string; cancel: boolean; paste: boolean; copyAddress: string | null } {
  return { text: flow.notice, cancel: true, paste: flow.manual && (flow.phase === 'paste' || flow.copyAddress !== null), copyAddress: flow.copyAddress };
}

type Flow = { id: string; title: string; port: number; host: string; path: string; manual: boolean; phase: SignInPhase; endsAt: number; copyAddress: string | null };
type Settled = { outcome?: SignInOutcome; error?: string };
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const httpAddress = (text: string): URL => {
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error('InvalidArguments'); }
  if (text.length > 8192 || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('InvalidArguments');
  return parsed;
};
const only = (value: unknown, allowed: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !allowed.includes(name))) throw new Error('InvalidArguments');
  return value as Record<string, unknown>;
};

/**
 * Synthetic stand-in for the native owner. Time is a simulated clock (`advance`) and ports are simulated numbers
 * (`occupy` holds one), so every end of a flow is deterministic. `check` is the grants preview's answer for the
 * caller; the caller identity is an argument, never part of the options.
 */
export function createSignInPreview() {
  const flows = new Map<string, Flow>();
  const settled = new Map<string, Settled>();
  const taken = new Set<number>();
  let now = 0, nextPort = 49200;
  const finish = (id: string, result: Settled) => { flows.delete(id); settled.set(id, result); };
  const tick = () => {
    for (const flow of [...flows.values()]) {
      if (flow.manual && flow.phase === 'waiting' && now >= flow.endsAt) { flow.phase = 'paste'; flow.endsAt += PASTE_WINDOW_MS; taken.delete(flow.port); }
      if (now < flow.endsAt) continue;
      taken.delete(flow.port); finish(flow.id, { outcome: { status: 'timeout' } });
    }
  };
  const release = (flow: Flow) => taken.delete(flow.port);
  const view = (flow: Flow): SignInFlow => ({ id: flow.id, title: flow.title, notice: `Waiting for sign-in: ${flow.title}`, phase: flow.phase, manual: flow.manual, remainingMs: Math.max(0, flow.endsAt - now), copyAddress: flow.copyAddress });
  return {
    /**
     * Starts a flow (the native call blocks until it ends; the preview returns the opened address and the outcome is
     * read with `outcome`). Throws the native error codes. `opener` is the test's browser: it receives the address.
     */
    start(check: string, id: string, caller: 'service' | 'panel', params: unknown, browser: 'works' | 'missing' = 'works'): { redirectUri: string; authorizeUrl: string } {
      if (caller !== 'service') throw new Error('UnsupportedCapability');
      if (check !== 'ok') throw new Error('PermissionDenied');
      tick();
      const options = only(params, ['authorizeUrl', 'callback', 'timeoutMs', 'manual', 'title']);
      if (typeof options.authorizeUrl !== 'string') throw new Error('InvalidArguments');
      httpAddress(options.authorizeUrl.replaceAll('{redirect_uri}', encode('http://127.0.0.1:1/callback')));
      const callback = only(options.callback, ['path', 'port', 'host']);
      const path = callback.path;
      if (typeof path !== 'string' || !path.startsWith('/') || path.length > 256 || /[\s\u0000-\u001f?#\\]/.test(path)) throw new Error('InvalidArguments');
      const port = callback.port ?? null;
      if (port !== null && (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)) throw new Error('InvalidArguments');
      const host = callback.host ?? '127.0.0.1';
      if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('InvalidArguments');
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_TIMEOUT_MS) throw new Error('InvalidArguments');
      if (options.manual !== undefined && typeof options.manual !== 'boolean') throw new Error('InvalidArguments');
      if (options.title !== undefined && (typeof options.title !== 'string' || [...options.title].length > 120 || /[\u0000-\u001f]/.test(options.title))) throw new Error('InvalidArguments');
      if (flows.has(id)) throw new Error('Conflict');
      let chosen = port as number | null;
      if (chosen === null) { while (taken.has(nextPort)) nextPort++; chosen = nextPort++; }
      if (taken.has(chosen)) throw new Error('Conflict');
      const redirectUri = `http://${host}:${chosen}${path}`;
      const authorizeUrl = options.authorizeUrl.replaceAll('{redirect_uri}', encode(redirectUri));
      httpAddress(authorizeUrl);
      const manual = options.manual === true;
      if (browser === 'missing' && !manual) throw new Error('HostUnavailable');
      taken.add(chosen); settled.delete(id);
      flows.set(id, { id, title: (options.title as string | undefined) || id, port: chosen, host, path, manual, phase: 'waiting', endsAt: now + (timeout as number), copyAddress: browser === 'missing' ? authorizeUrl : null });
      return { redirectUri, authorizeUrl };
    },
    /** One request of the simulated browser to the callback listener: the status the host answers, and what happens. */
    browser(id: string, request: { method?: string; target: string }): number {
      tick();
      const flow = flows.get(id);
      if (!flow || flow.phase !== 'waiting') throw new Error('ConnectionRefused');
      const method = request.method ?? 'GET';
      if (!request.target.startsWith('/') || method !== 'GET') { release(flow); finish(id, { error: 'InvalidShape' }); return method !== 'GET' && request.target.startsWith('/') ? 405 : 400; }
      if (request.target.split(/[?#]/)[0] !== flow.path) return 404;
      release(flow);
      finish(id, { outcome: { status: 'completed', url: `http://${flow.host}:${flow.port}${request.target}`, redirectUri: `http://${flow.host}:${flow.port}${flow.path}`, via: 'callback' } });
      return 200;
    },
    cancel(id: string): boolean { const flow = flows.get(id); if (!flow) return false; release(flow); finish(id, { outcome: { status: 'cancelled' } }); return true; },
    paste(id: string, url: string): void {
      const flow = flows.get(id);
      if (!flow) throw new Error('NotFound');
      if (!flow.manual) throw new Error('UnsupportedCapability');
      const parsed = httpAddress(url.trim());
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port !== String(flow.port) || parsed.pathname !== flow.path) throw new Error('InvalidArguments');
      release(flow);
      finish(id, { outcome: { status: 'completed', url: url.trim(), redirectUri: `http://${flow.host}:${flow.port}${flow.path}`, via: 'manual' } });
    },
    /** The grant went away (revoke, narrowing, untrust, disable, safe mode): the flow ends and frees its port. */
    revoke(id: string): void { const flow = flows.get(id); if (!flow) return; release(flow); finish(id, { error: 'PermissionDenied' }); },
    advance(ms: number): void { now += ms; tick(); },
    occupy(port: number): void { taken.add(port); },
    free(port: number): void { taken.delete(port); },
    listening(port: number): boolean { return taken.has(port); },
    /** `null` while the flow waits; otherwise the status, or the error code the native call would have thrown. */
    outcome(id: string): { pending: true } | { pending: false; outcome?: SignInOutcome; error?: string } {
      tick();
      if (flows.has(id)) return { pending: true };
      const result = settled.get(id);
      if (!result) throw new Error('NotFound');
      return { pending: false, ...result };
    },
    projection(): SignInProjection { tick(); return { schemaVersion: 1, available: true, flows: [...flows.values()].sort((a, b) => a.id.localeCompare(b.id)).map(view) }; },
  };
}
