/**
 * Declared connection requests and the JSON adapter (`connections.request`, runtime slice R0804): the shared reading
 * of a declared operation and a synthetic preview of the native owner
 * (`src-tauri/src/extensions/runtime_connection_adapters.rs`).
 *
 * A package declares a connection (address, method, fixed headers, how a credential is attached, adapter) and asks for
 * it by name. The host builds the request, attaches the credential and returns the answer; the credential is never
 * returned (ADR-0006). This file has no browser or Tauri import, so a test can drive it from Node against a real
 * loopback API. The browser preview runs no package code and has no network of its own: its transport is a function
 * the test supplies, and its secrets are the labelled stand-ins of the private-secrets preview.
 */
export const CONNECTIONS_PERMISSION = 'connections.request';
export const DEFAULT_RESPONSE_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const SUMMARY_RESPONSE_BYTES = 32 * 1024;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_PAIRS = 16;
const MAX_RUNNING = 8;
const MAX_STORED = 64;
const RESERVED = ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'cookie', 'authorization', 'content-type'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ConnectionsMethod = 'connections.status' | 'connections.start' | 'connections.poll' | 'connections.cancel';
export type ConnectionsCaller = 'service' | 'panel';
export type Auth = { kind: 'none' } | { kind: 'bearer' } | { kind: 'header'; name: string } | { kind: 'query'; name: string };
export type Source = { kind: 'host' } | { kind: 'secret'; key: string } | { kind: 'held'; id: string };
export type OperationPlan = {
  method: string; url: URL; headers: [string, string][]; bodyAllowed: boolean; auth: Auth; source: Source;
  adapter: 'json-summary' | 'json'; maxBytes: number; timeoutMs: number;
};
export type PreparedRequest = { method: string; url: string; headers: [string, string][]; body: string | null };
export type ConnectionSummary = { schemaVersion: 1; accepted: boolean; count: number };
export type ConnectionJson = { schemaVersion: 1; status: number; body: Json };
export type ConnectionRequest = { schemaVersion: 1; request: string; state: 'running' | 'completed' | 'failed'; response: ConnectionSummary | ConnectionJson | null; error: string | null };
export type Transport = (request: PreparedRequest) => Promise<{ status: number; text: string; redirected?: boolean }>;

class Refusal extends Error { constructor(readonly code: string) { super(code); } }
const refuse = (code: string): never => { throw new Refusal(code); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const token = (name: unknown): name is string => typeof name === 'string' && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(name);
const queryName = (name: unknown): name is string => typeof name === 'string' && /^[0-9A-Za-z_.~-]{1,64}$/.test(name);
const plain = (text: unknown): text is string => typeof text === 'string' && text.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(text);
const reserved = (name: string) => RESERVED.includes(name.toLowerCase());

/** https, or http on a numeric loopback address; a query is part of the declared address; no user information, no fragment. */
export function address(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return refuse('PermissionDenied'); }
  const loopback = /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || url.username || url.password || url.hash) refuse('PermissionDenied');
  return url;
}

/** Reads one declared operation from the manifest of the granted package. Throws the native error codes. */
export function planOperation(manifest: Record<string, unknown>, connection: string, operation: string, command?: string): OperationPlan {
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes(CONNECTIONS_PERMISSION)) refuse('PermissionDenied');
  const declared = ((manifest.contributes as Record<string, unknown> | undefined)?.connections as Record<string, unknown>[] | undefined)?.find(item => item.id === connection && (command === undefined || item.command === command));
  if (!declared) refuse('PermissionDenied');
  const op = (declared!.operations as Record<string, unknown>[] | undefined)?.find(item => item.id === operation);
  if (!op) refuse('PermissionDenied');
  if (typeof op!.method !== 'string' || !METHODS.includes(op!.method)) refuse('UnsupportedCapability');
  const authentication = declared!.authentication;
  let auth: Auth;
  if (authentication === 'bearer' || authentication === 'none') auth = { kind: authentication };
  else if (authentication === 'header') auth = { kind: 'header', name: token(declared!.headerName) && !reserved(declared!.headerName as string) ? declared!.headerName as string : refuse('InvalidShape') };
  else if (authentication === 'query') auth = { kind: 'query', name: queryName(declared!.queryName) ? declared!.queryName as string : refuse('InvalidShape') };
  else return refuse('UnsupportedCapability');
  if (declared!.adapter !== 'json-summary' && declared!.adapter !== 'json') refuse('UnsupportedCapability');
  const adapter = declared!.adapter as 'json-summary' | 'json';
  let source: Source = { kind: 'host' };
  const credential = declared!.credential;
  if (credential !== undefined && credential !== null) {
    if (!isObject(credential)) refuse('InvalidShape');
    const map = credential as Record<string, unknown>, size = Object.keys(map).length;
    if (map.source === 'host' && size === 1) source = { kind: 'host' };
    else if (map.source === 'secret' && size === 2 && typeof map.key === 'string' && map.key.length >= 1 && map.key.length <= 64) source = { kind: 'secret', key: map.key };
    else if (map.source === 'held' && size === 2 && plain(map.id) && (map.id as string).length >= 1 && (map.id as string).length <= 128) source = { kind: 'held', id: map.id as string };
    else refuse('InvalidShape');
  }
  let maxBytes = SUMMARY_RESPONSE_BYTES;
  if (adapter === 'json') {
    const size = declared!.maxResponseBytes;
    if (size === undefined) maxBytes = DEFAULT_RESPONSE_BYTES;
    else if (typeof size === 'number' && Number.isInteger(size) && size >= 1 && size <= MAX_RESPONSE_BYTES) maxBytes = size;
    else refuse('InvalidShape');
  }
  const timeoutMs = declared!.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) refuse('InvalidShape');
  const headers: [string, string][] = [];
  if (op!.headers !== undefined) {
    if (!isObject(op!.headers) || Object.keys(op!.headers).length > MAX_PAIRS) refuse('InvalidShape');
    for (const [name, value] of Object.entries(op!.headers as Record<string, unknown>)) {
      if (!plain(value) || !token(name) || reserved(name) || auth.kind === 'header' && auth.name.toLowerCase() === name.toLowerCase()) refuse('InvalidShape');
      headers.push([name, value as string]);
    }
  }
  let bodyAllowed = false;
  if (op!.body !== undefined) { if (op!.body !== 'json') refuse('InvalidShape'); bodyAllowed = op!.method !== 'GET'; }
  return { method: op!.method as string, url: address(String(op!.url)), headers, bodyAllowed, auth, source, adapter, maxBytes, timeoutMs: timeoutMs as number };
}

/** What `start` supplied, checked against the declaration. The credential is not part of it. */
export function prepareRequest(plan: OperationPlan, body?: unknown, query?: unknown): PreparedRequest {
  let text: string | null = null;
  if (body !== undefined && body !== null) {
    if (!plan.bodyAllowed) refuse('InvalidShape');
    text = JSON.stringify(body);
    if (byteLength(text) > MAX_BODY_BYTES) refuse('LimitExceeded');
  }
  const url = new URL(plan.url);
  if (query !== undefined && query !== null) {
    if (!isObject(query)) refuse('InvalidShape');
    const pairs = Object.entries(query as Record<string, unknown>);
    if (pairs.length > MAX_PAIRS) refuse('LimitExceeded');
    for (const [name, value] of pairs) {
      if (!plain(value) || !queryName(name) || plan.auth.kind === 'query' && plan.auth.name === name) refuse('InvalidShape');
    }
    for (const [name, value] of pairs) url.searchParams.append(name, value as string);
  }
  return { method: plan.method, url: url.toString(), headers: plan.headers.map(([name, value]) => [name, value]), body: text };
}

function redact(value: Json, secret: string): Json {
  if (typeof value === 'string') return value.includes(secret) ? value.split(secret).join('[redacted]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name.split(secret).join('[redacted]'), redact(item, secret)]));
  return value;
}

/** Only the adapter's projection crosses; a credential found in a JSON answer is replaced. */
export function project(adapter: OperationPlan['adapter'], status: number, text: string, secret?: string | null): ConnectionSummary | ConnectionJson {
  const hidden = secret || null;
  let parsed: Json;
  if (adapter === 'json' && !text.trim()) parsed = null;
  else { try { parsed = JSON.parse(text) as Json; } catch { return refuse('InvalidShape'); } }
  if (adapter === 'json-summary') {
    const body = parsed as Record<string, Json> | null;
    if (!isObject(body) || typeof body.accepted !== 'boolean' || !Number.isInteger(body.count) || (body.count as number) < 0 || (body.count as number) > 1_000_000) refuse('InvalidShape');
    const value: ConnectionSummary = { schemaVersion: 1, accepted: body!.accepted as boolean, count: body!.count as number };
    if (hidden && JSON.stringify(value).includes(hidden)) refuse('PermissionDenied');
    return value;
  }
  return { schemaVersion: 1, status, body: hidden ? redact(parsed, hidden) : parsed };
}

type Pending = { owner: string; version: string; cancel: { stopped: boolean }; result: { value?: ConnectionSummary | ConnectionJson; error?: string } | null };
export type ConnectionsPreviewOptions = {
  /** The network of the preview: one function, supplied by the test. A real loopback call, or a refusal. */
  transport: Transport;
  /** The package-secret stand-in's value for a key; `null` when the package holds none. */
  secret: (id: string, key: string) => string | null;
};
export type GrantCheck = 'ok' | string;

/**
 * Synthetic stand-in for the native owner. The same rules (service only, grant checked per call, declared operations,
 * `body`/`query` limits, credential per source, bounded outcomes). `check` is the grants preview's answer for the
 * caller (`ok` or a refusal); the caller identity and its manifest are arguments, never part of the request.
 */
export function createConnectionAdaptersPreview(options: ConnectionsPreviewOptions) {
  const pending = new Map<string, Pending>();
  const order: string[] = [];
  let serial = 0;
  const fields = (params: unknown, allowed: string[]): Record<string, unknown> => {
    if (!isObject(params) || Object.keys(params).some(name => !allowed.includes(name))) refuse('InvalidShape');
    return params as Record<string, unknown>;
  };
  const text = (map: Record<string, unknown>, name: string) => { const value = map[name]; return typeof value === 'string' && value.length >= 1 && value.length <= 256 ? value : refuse('InvalidShape'); };
  const dto = (request: string): ConnectionRequest => {
    const item = pending.get(request)!;
    const state = item.result === null ? 'running' : item.result.error ? 'failed' : 'completed';
    return { schemaVersion: 1, request, state, response: item.result?.value ?? null, error: item.result?.error ?? null };
  };
  const settle = (request: string, result: Pending['result']) => { const item = pending.get(request); if (item && item.result === null) item.result = item.cancel.stopped ? { error: 'Cancelled' } : result; };
  async function run(plan: OperationPlan, prepared: PreparedRequest, secret: string | null, cancel: { stopped: boolean }, stopped: () => boolean): Promise<NonNullable<Pending['result']>> {
    let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    try {
      const answer = await Promise.race([
        options.transport(attach(plan, prepared, secret)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Refusal('Timeout')), plan.timeoutMs); }),
        new Promise<never>((_, reject) => { poll = setInterval(() => { if (stopped()) reject(new Refusal('PermissionDenied')); else if (cancel.stopped) reject(new Refusal('Cancelled')); }, 10); }),
      ]);
      if (stopped()) return { error: 'PermissionDenied' };
      if (cancel.stopped) return { error: 'Cancelled' };
      if (answer.redirected || answer.status >= 300 && answer.status < 400) return { error: 'PermissionDenied' };
      if (byteLength(answer.text) > plan.maxBytes) return { error: 'LimitExceeded' };
      const json = plan.adapter === 'json' && (() => { try { JSON.parse(answer.text); return true; } catch { return false; } })();
      if (!(answer.status >= 200 && answer.status < 300) && !json) return { error: 'HostUnavailable' };
      return { value: project(plan.adapter, answer.status, answer.text, secret) };
    } catch (error) {
      return { error: error instanceof Refusal ? error.code : 'HostUnavailable' };
    } finally { clearTimeout(timer); clearInterval(poll); }
  }
  /** The credential rides on the prepared request only inside the transport call; nothing keeps or returns it. */
  function attach(plan: OperationPlan, prepared: PreparedRequest, secret: string | null): PreparedRequest {
    const headers = [...prepared.headers, ['accept', 'application/json']] as [string, string][];
    let url = prepared.url;
    if (prepared.body !== null) headers.push(['content-type', 'application/json']);
    if (secret !== null) {
      if (plan.auth.kind === 'bearer') headers.push(['authorization', `Bearer ${secret}`]);
      else if (plan.auth.kind === 'header') headers.push([plan.auth.name, secret]);
      else if (plan.auth.kind === 'query') { const target = new URL(url); target.searchParams.append(plan.auth.name, secret); url = target.toString(); }
    }
    return { ...prepared, url, headers };
  }
  return {
    /** The one entry of the preview dispatcher; throws the native error codes. `held` is the item grant of `credentials.use`. */
    handle(check: GrantCheck, id: string, version: string, caller: ConnectionsCaller, manifest: Record<string, unknown>, method: string, params: unknown, held: (item: string) => GrantCheck = () => 'PermissionDenied'): ConnectionRequest | { schemaVersion: 1; state: 'connected' | 'disconnected'; credential: null } {
      if (!['connections.status', 'connections.start', 'connections.poll', 'connections.cancel'].includes(method) || caller !== 'service') refuse('UnsupportedCapability');
      if (check !== 'ok') refuse('PermissionDenied');
      if (method === 'connections.poll' || method === 'connections.cancel') {
        const map = fields(params, ['connection', 'operation', 'request']), request = text(map, 'request');
        const item = pending.get(request);
        if (!item || item.owner !== id || item.version !== version) refuse('PermissionDenied');
        if (method === 'connections.cancel' && item!.result === null) { item!.cancel.stopped = true; item!.result = { error: 'Cancelled' }; }
        return dto(request);
      }
      const map = fields(params, method === 'connections.start' ? ['connection', 'operation', 'credential', 'body', 'query'] : ['connection', 'operation']);
      const plan = planOperation(manifest, text(map, 'connection'), text(map, 'operation'));
      const heldItem = plan.source.kind === 'held' ? plan.source.id : null;
      if (heldItem !== null) { const answer = held(heldItem); if (answer !== 'ok') refuse('PermissionDenied'); }
      const secret = plan.auth.kind === 'none' ? null : plan.source.kind === 'secret' ? options.secret(id, plan.source.key) ?? refuse('NotFound') : null;
      if (method === 'connections.status') return { schemaVersion: 1, state: plan.auth.kind === 'none' || secret !== null ? 'connected' : 'disconnected', credential: null };
      const handle = map.credential;
      const accepted = plan.auth.kind === 'none' ? handle === undefined : plan.source.kind === 'host' ? typeof handle === 'string' : handle === undefined;
      if (!accepted) refuse('InvalidShape');
      const prepared = prepareRequest(plan, map.body, map.query);
      if (heldItem !== null || plan.auth.kind !== 'none' && plan.source.kind === 'host') refuse('NotFound');
      const running = [...pending.values()].filter(item => item.owner === id && item.result === null).length;
      if (running >= MAX_RUNNING) refuse('Conflict');
      if (pending.size >= MAX_STORED) {
        const old = order.find(request => pending.get(request)?.result !== null);
        if (!old) refuse('LimitExceeded');
        pending.delete(old!); order.splice(order.indexOf(old!), 1);
      }
      const request = `request-${++serial}`, cancel = { stopped: false };
      pending.set(request, { owner: id, version, cancel, result: null }); order.push(request);
      void run(plan, prepared, secret, cancel, () => check !== 'ok').then(result => settle(request, result));
      return dto(request);
    },
    /** Revoking the grant ends what runs: its output is dropped. */
    revoke(id: string) { for (const item of pending.values()) if (item.owner === id) { item.cancel.stopped = true; item.result = { error: 'PermissionDenied' }; } },
    forget(id: string) { for (const [request, item] of pending) if (item.owner === id) { item.cancel.stopped = true; pending.delete(request); } },
  };
}
