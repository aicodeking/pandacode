import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';

// R1209: the sign-in provider (sample.signin). PREVIEW column: the shipped lib/signin.mjs of the example package runs in
// Node against B3's browser-importable identity and API core (fake-cloud.mjs, no sockets) with a scripted `panda`: the
// host's browser flow is replaced by the same call the real host makes against B3's identity listener (what B4, the fake
// browser, does over a socket). It proves the package's logic and what the host would be handed. The declared fake ACP
// harness is B5 over real stdio. The installed package, the real loopback listener and the installed window are NOT proven
// here: they are prepared in tests/fixtures/extensions/example-signin/evidence-columns.json.
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('examples/extensions/signin/package/extension.json'));
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const PROVIDER = 'sample.signin/cloud';
const IDENTITY = 'http://identity.test';
const API = 'http://api.test';
const CANARY = /tok-/;

type Json = any;
type Recorded = { notices: Json[]; updates: Json[]; statuses: string[]; secrets: Map<string, string>; denied: Set<string> };

async function challenge(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function boot(over: { emails?: string[]; settings?: Record<string, string> } = {}) {
  const { createCloud } = await import('./fixtures/extensions/backends/core/fake-cloud.mjs');
  const logic = await import('../examples/extensions/signin/package/lib/signin.mjs');
  let clock = 1_000_000;
  const cloud = createCloud({ now: () => clock, challenge });
  const emails = [...(over.emails ?? ['dev@example.test', 'second@example.test'])];
  const record: Recorded = { notices: [], updates: [], statuses: [], secrets: new Map(), denied: new Set() };
  const requests: { listener: string; method: string; path: string; grant?: string }[] = [];
  const handlers = new Map<string, (arg?: unknown) => Promise<Json>>();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const stops: (() => unknown)[] = [];
  const flow: { next: Json | null; open: boolean; urls: string[]; conflict: boolean } = { next: null, open: false, urls: [], conflict: false };
  const dialogs: { answer: Json; seen: Json[] } = { answer: { status: 'cancelled' }, seen: [] };

  // The fake network: every URL goes to B3's identity or API core in process.
  const fetchB3 = async (url: string, init: Json = {}) => {
    const target = new URL(url);
    const listener = target.origin === IDENTITY ? 'identity' : 'api';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    let data: Json = {};
    if (init.body instanceof URLSearchParams) data = Object.fromEntries(init.body);
    else if (typeof init.body === 'string' && init.body) data = JSON.parse(init.body);
    requests.push({ listener, method: init.method ?? 'GET', path: target.pathname, grant: data.grant_type });
    let result = await cloud.request(listener, init.method ?? 'GET', target, headers, data);
    if (listener === 'identity' && target.pathname === '/userinfo' && result.status === 200) result = { ...result, data: { email: emails[0] } };
    const table = new Map(Object.entries(result.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    return { ok: result.status >= 200 && result.status < 300, status: result.status, headers: { get: (name: string) => table.get(name.toLowerCase()) ?? null }, json: async () => structuredClone(result.data) };
  };
  const guard = (name: string) => { if (record.denied.has(name)) throw Object.assign(new Error('PermissionDenied'), { code: 'PermissionDenied' }); };
  const panda = {
    commands: { register: (id: string, handler: (arg?: unknown) => Promise<Json>) => { handlers.set(id, handler); return { dispose: () => handlers.delete(id) }; } },
    secrets: {
      get: async ({ key }: { key: string }) => { guard('secrets.private'); return { value: record.secrets.get(key) ?? null }; },
      set: async ({ key, value }: { key: string; value: string }) => { guard('secrets.private'); record.secrets.set(key, value); return null; },
      delete: async ({ key }: { key: string }) => { guard('secrets.private'); record.secrets.delete(key); return null; },
      list: async () => ({ keys: [...record.secrets.keys()] }),
    },
    settings: { get: async () => ({ schemaVersion: 1, revision: 1, values: { identity: IDENTITY, api: API, wait: '30', ...(over.settings ?? {}) } }) },
    providers: { update: async (id: string, state: Json) => { guard('ui.dynamic'); expect(id).toBe(PROVIDER); record.updates.push(structuredClone(state)); return null; } },
    ui: {
      notify: async (notice: Json) => { guard('ui.notify'); record.notices.push(structuredClone(notice)); return null; },
      showDialog: async (dialog: Json) => { dialogs.seen.push(structuredClone(dialog)); return dialogs.answer; },
    },
    auth: {
      // The host's browser flow: B4 opens the authorization address and B3's identity listener redirects to the loopback address.
      signIn: async (options: Json) => {
        guard('auth.signIn');
        if (flow.conflict || flow.open) throw Object.assign(new Error('Conflict'), { code: 'Conflict' });
        const redirectUri = 'http://127.0.0.1:50123/callback';
        const url = options.authorizeUrl.replace('{redirect_uri}', encodeURIComponent(redirectUri));
        flow.urls.push(url);
        if (flow.next) { const answer = flow.next; flow.next = null; return answer; }
        const answer = await cloud.request('identity', 'GET', new URL(url), {}, {});
        if (answer.status !== 302) return { status: 'timeout' };
        return { status: 'completed', url: answer.headers.location, redirectUri, via: 'callback' };
      },
    },
  };
  const lifetime = { onStop: (handler: () => unknown) => { stops.push(handler); return { dispose: () => undefined }; }, setStatus: async ({ text }: { text: string }) => { record.statuses.push(text); return null; } };
  const sleeps: number[] = [];
  const service = await logic.run(panda as never, lifetime as never, {
    fetch: fetchB3,
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
    setTimeout: (fn: () => void, ms: number) => { const entry = { fn, ms, live: true }; timers.push(entry); return entry; },
    clearTimeout: (entry: { live: boolean }) => { entry.live = false; },
    pkce: async () => ({ verifier: 'v'.repeat(43), challenge: await challenge('v'.repeat(43)), state: 'state-fixture' }),
  });
  const everything = () => JSON.stringify({ updates: record.updates, notices: record.notices, statuses: record.statuses, dialogs: dialogs.seen });
  const lastUpdate = () => record.updates[record.updates.length - 1];
  return {
    cloud, record, requests, handlers, timers, stops, flow, dialogs, service, sleeps, everything, lastUpdate,
    advance: (ms: number) => { clock += ms; },
    refreshCount: () => requests.filter(item => item.grant === 'refresh_token').length,
    run: (id: string) => handlers.get(id)!(),
    nextEmail: () => emails.shift(),
  };
}
type Rig = Awaited<ReturnType<typeof boot>>;
const signedIn = async (rig: Rig) => { const result = await rig.run('sample.signin/sign-in'); expect(result.status).toBe('completed'); };

test('signin example: the package is a valid service package with a declared harness launch, its own secrets and no token', () => {
  const checked = validateContract('packages', [structuredClone(manifest)]);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'secrets.private', 'auth.signIn', 'ui.dynamic', 'ui.notify']);
  const provider = manifest.contributes.providers[0];
  expect(provider.models).toEqual([]);
  expect(provider.metadata.readiness.state).toBe('signedOut');
  expect(provider.launch.protocol).toBe('acp');
  expect(provider.metadata.signIn.command).toBe('sample.signin/sign-in');
  const ids = manifest.contributes.commands.map((command: { id: string }) => command.id);
  expect(ids).toEqual(expect.arrayContaining(['sample.signin/sign-in', 'sample.signin/add-account', 'sample.signin/sign-out', 'sample.signin/accounts']));
  const source = read('examples/extensions/signin/package/lib/signin.mjs');
  expect(source).not.toMatch(/\bimport\s|require\(|process\.|credentials\.read/);
  expect(JSON.stringify(manifest) + source).not.toMatch(CANARY);
});

test('signin example: signed out first, then sign-in makes the provider ready with the account, two models and the limit windows', async () => {
  const rig = await boot();
  expect(rig.lastUpdate().readiness).toEqual({ state: 'signedOut', reason: 'Sign in to use Sample cloud.' });
  expect(rig.lastUpdate().models).toBeUndefined();
  await signedIn(rig);
  const state = rig.lastUpdate();
  expect(state.readiness.state).toBe('ready');
  expect(state.account).toEqual({ label: 'dev@example.test' });
  expect(state.models.map((model: Json) => model.id)).toEqual(['fixture-small', 'fixture-large']);
  expect(state.models[1].contextWindow).toBe(32768);
  expect(state.limits.windows.map((window: Json) => [window.id, window.usedPercent])).toEqual([['5h', 37], ['week', 12]]);
  expect(state.limits.windows[0].resetsAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  // The authorization address carried a state value and an S256 challenge, with the host's redirect placeholder replaced.
  const url = new URL(rig.flow.urls[0]);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('state')).toBe('state-fixture');
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:50123/callback');
  expect(rig.record.statuses.at(-1)).toBe('signed in (1)');
});

test('signin example: cancel, timeout, a wrong state and access_denied store nothing and leave the provider signed out', async () => {
  const rig = await boot();
  rig.flow.next = { status: 'cancelled' };
  expect((await rig.run('sample.signin/sign-in')).status).toBe('cancelled');
  rig.flow.next = { status: 'timeout' };
  expect((await rig.run('sample.signin/sign-in')).status).toBe('timeout');
  rig.cloud.control('mode', { authorize: 'bad-state' });
  expect((await rig.run('sample.signin/sign-in')).status).toBe('refused');
  rig.cloud.control('mode', { authorize: 'deny' });
  expect((await rig.run('sample.signin/sign-in')).status).toBe('refused');
  expect(rig.record.notices.map(notice => notice.text)).toEqual(expect.arrayContaining(['Sign-in cancelled.', 'Sign-in timed out.', 'Sign-in refused: the state value did not match.', 'Sign-in refused: access_denied.']));
  expect(rig.record.secrets.size).toBe(0);
  expect(rig.requests.filter(item => item.path === '/token')).toHaveLength(0);
  expect(rig.lastUpdate().readiness.state).toBe('signedOut');
});

test('signin example: a manual paste after a hang completes through the host, and a second flow is a Conflict notice', async () => {
  const rig = await boot();
  // With the identity server hanging, the host's wait ends and its paste dialog takes over: the answer comes back as `manual`
  // with the redirected address the user pasted. The redirected address is minted by B3 (a real code) in the approve mode.
  const redirectUri = 'http://127.0.0.1:50123/callback';
  rig.cloud.control('mode', { authorize: 'hang' });
  expect((await rig.cloud.request('identity', 'GET', new URL(`${IDENTITY}/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(redirectUri)}&state=s&code_challenge=c&code_challenge_method=S256`), {}, {})).hang).toBe(true);
  rig.cloud.control('mode', { authorize: 'approve' });
  const primed = await rig.cloud.request('identity', 'GET', new URL(`${IDENTITY}/authorize?response_type=code&client_id=sample-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=state-fixture&code_challenge=${await challenge('v'.repeat(43))}&code_challenge_method=S256`), {}, {});
  rig.flow.next = { status: 'completed', url: primed.headers.location, redirectUri, via: 'manual' };
  expect((await rig.run('sample.signin/sign-in')).status).toBe('completed');
  rig.flow.conflict = true;
  expect((await rig.run('sample.signin/add-account')).status).toBe('failed');
  expect(rig.record.notices.at(-1).text).toBe('A sign-in is already open.');
  expect(rig.service.accountsList()).toEqual(['dev@example.test']);
});

test('signin example: two callers that meet an expired token cause exactly one refresh request, and the user sees nothing', async () => {
  const rig = await boot();
  await signedIn(rig);
  const noticesBefore = rig.record.notices.length;
  rig.cloud.control('expire');
  rig.service.expireNow();
  const answers = await Promise.all([rig.service.call('/v1/models'), rig.service.call('/v1/usage')]);
  expect(answers.map(answer => answer.status)).toEqual([200, 200]);
  expect(rig.refreshCount()).toBe(1);
  expect(rig.record.notices.length).toBe(noticesBefore);
});

test('signin example: the refresh timer fires before expiry, refreshes quietly and republishes', async () => {
  const rig = await boot();
  await signedIn(rig);
  const timer = rig.timers.filter(entry => entry.live).at(-1)!;
  expect(timer.ms).toBeGreaterThanOrEqual(1000);
  rig.advance(timer.ms + 1);
  const before = rig.record.updates.length;
  timer.fn();
  await expect.poll(() => rig.refreshCount(), { timeout: 2000 }).toBe(1);
  await expect.poll(() => rig.record.updates.length, { timeout: 2000 }).toBeGreaterThan(before);
  expect(rig.lastUpdate().readiness.state).toBe('ready');
});

test('signin example: a revoked session returns the provider to signed out with "Sign in again" and the service does not loop', async () => {
  const rig = await boot();
  await signedIn(rig);
  rig.cloud.control('revoke');
  rig.service.expireNow();
  await rig.service.sync();
  expect(rig.lastUpdate().readiness).toEqual({ state: 'signedOut', reason: 'Sign in again to use Sample cloud.' });
  expect(rig.lastUpdate().models).toBeUndefined();
  expect(rig.record.notices.at(-1).text).toContain('Sign in again');
  expect(rig.record.secrets.size).toBe(0);
  const calls = rig.requests.length;
  await rig.service.sync();
  expect(rig.requests.length).toBe(calls);
  expect(rig.requests.filter(item => item.grant === 'refresh_token').length).toBeLessThanOrEqual(1);
});

test('signin example: one account waits the time the API named; a second account is switched to and named', async () => {
  const rig = await boot();
  await signedIn(rig);
  rig.cloud.control('rate-limit', { count: 1, retryAfterMs: 2000 });
  expect((await rig.service.call('/v1/models')).status).toBe(200);
  expect(rig.sleeps).toEqual([2000]);
  expect(rig.record.notices.at(-1).text).toBe('Rate limited, retrying in 2 s.');
  // A second account: the next sign-in reports another e-mail address.
  rig.nextEmail();
  await signedIn(rig);
  expect(rig.service.accountsList()).toEqual(['dev@example.test', 'second@example.test']);
  rig.cloud.control('rate-limit', { count: 1, retryAfterMs: 2000 });
  expect((await rig.service.call('/v1/models')).status).toBe(200);
  expect(rig.record.notices.at(-1).text).toBe('Rate limited on second@example.test; switched to dev@example.test.');
  expect(rig.sleeps).toEqual([2000]);
});

test('signin example: the account dialog switches or removes an account, and a cancelled dialog changes nothing', async () => {
  const rig = await boot();
  await signedIn(rig);
  rig.nextEmail();
  await signedIn(rig);
  expect(rig.lastUpdate().account).toEqual({ label: 'second@example.test' });
  expect((await rig.run('sample.signin/accounts')).status).toBe('cancelled');
  expect(rig.dialogs.seen[0].fields[0].options.map((option: Json) => option.value)).toEqual(['dev@example.test', 'second@example.test']);
  rig.dialogs.answer = { status: 'confirmed', values: { account: 'dev@example.test', remove: false } };
  await rig.run('sample.signin/accounts');
  expect(rig.lastUpdate().account).toEqual({ label: 'dev@example.test' });
  rig.dialogs.answer = { status: 'confirmed', values: { account: 'dev@example.test', remove: true } };
  await rig.run('sample.signin/accounts');
  expect(rig.service.accountsList()).toEqual(['second@example.test']);
  expect(rig.lastUpdate().account).toEqual({ label: 'second@example.test' });
});

test('signin example: sign out deletes the stored secrets and no token appears in any published value, notice, status or dialog', async () => {
  const rig = await boot();
  await signedIn(rig);
  const stored = rig.record.secrets.get('accounts') ?? '';
  expect(stored).toMatch(CANARY);
  expect([...rig.record.secrets.keys()]).toEqual(['accounts']);
  rig.cloud.control('rate-limit', { count: 1, retryAfterMs: 1000 });
  await rig.service.call('/v1/models');
  await rig.run('sample.signin/sign-out');
  expect(rig.record.secrets.size).toBe(0);
  expect(rig.lastUpdate().readiness.state).toBe('signedOut');
  expect(rig.record.statuses.at(-1)).toBe('signed out');
  expect(rig.everything()).not.toMatch(CANARY);
});

test('signin example: losing the secrets or sign-in grant fails safely, and stopping the service ends its timer and its publishing', async () => {
  const rig = await boot();
  rig.record.denied.add('auth.signIn');
  expect((await rig.run('sample.signin/sign-in')).status).toBe('failed');
  expect(rig.record.notices.at(-1).text).toBe('Sign-in is not allowed for this package.');
  expect(rig.record.secrets.size).toBe(0);
  rig.record.denied.delete('auth.signIn');
  await signedIn(rig);
  const timer = rig.timers.filter(entry => entry.live).at(-1)!;
  for (const stop of rig.stops) await stop();
  expect(timer.live).toBe(false);
  const updates = rig.record.updates.length;
  await rig.service.sync();
  expect(rig.record.updates.length).toBe(updates);
  expect(rig.everything()).not.toMatch(CANARY);
});

test('signin example: the declared fake ACP harness converses after sign-in, two tasks share the one provider state, and no token reaches it', async () => {
  const rig = await boot();
  await signedIn(rig);
  expect(rig.lastUpdate().readiness.state).toBe('ready');
  const launch = manifest.contributes.providers[0].launch;
  const command = launch.command.map((part: string) => (part === '__FAKE_AGENT__' ? agentPath : part === '{node}' ? process.execPath : part));
  // What the host would start: the manifest's argument list and environment, with no held value in either.
  expect(JSON.stringify({ command, env: launch.env })).not.toMatch(CANARY);
  const open = async () => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
    const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    await new Promise<void>((resolve, reject) => { createInterface({ input: child.stderr }).once('line', () => resolve()); child.once('error', reject); });
    const received: Json[] = []; const waiting = new Map<number, (frame: Json) => void>(); let serial = 0;
    createInterface({ input: child.stdout }).on('line', line => { const frame = JSON.parse(line); received.push(frame); if (frame.id !== undefined && !frame.method) waiting.get(frame.id)?.(frame); });
    const call = (method: string, params: unknown) => { const id = ++serial; return new Promise<Json>(resolve => { waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }); };
    await call('initialize', { protocolVersion: 1 });
    const session = (await call('session/new', { cwd: '.', mcpServers: [] })).result.sessionId as string;
    const ask = (text: string) => call('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] });
    const close = async () => { child.stdin.end(); return Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))]); };
    return { ask, received, close };
  };
  const [first, second] = [await open(), await open()];
  const [one, two] = await Promise.all([first.ask('hello from task one'), second.ask('hello from task two')]);
  expect(one.result?.stopReason ?? one.error).toBeTruthy();
  expect(two.result?.stopReason ?? two.error).toBeTruthy();
  expect(JSON.stringify([first.received, second.received])).not.toMatch(CANARY);
  // Sign-out changes readiness once for both: the roster has one overlay per provider.
  await rig.run('sample.signin/sign-out');
  expect(rig.lastUpdate().readiness.state).toBe('signedOut');
  expect(await first.close()).not.toBe('timeout');
  expect(await second.close()).not.toBe('timeout');
});
