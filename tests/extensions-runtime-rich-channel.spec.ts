import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { validateContract } from '../src/extensions/contracts';
import {
  BODY_LIMIT, CLOSED, MESSAGE_LIMIT, NO_SERVICE, PanelChannel, PreviewPanelHost, RATE_LIMIT, SERVICE_ONLY, STATE_LIMIT, TOO_FAST,
  parseRequest, placementOf, serviceOnly, themeFrom, validTheme, type Envelope,
} from '../src/extensions/runtime-rich-channel';
import { createRuntimePreview, type DaemonFactory, type Grants, type PreviewManifest, type ServiceModule } from '../src/extensions/runtime-preview';
import { mountFor, originKey, previewMountFromUrl, respondPanel, shellUrl, type PanelMount, type PanelServed } from '../src/extensions/runtime-rich-assets';

// PREVIEW column of R0303. The Node checks drive `src/extensions/runtime-rich-channel.ts` (the twin of the native
// `runtime_service_lifetime::runtime_rich_channel`) with the R0208 preview runner, the fixture service
// `tests/fixtures/extensions/runtime-rich-channel/service.mjs` and B1's browser-importable fake daemon; the client
// checks run the real `rich-view-client.js` in a VM; the browser check frames the real shell and client from a package
// origin answered by `respondPanel` (no `pandapanel` scheme in a browser). Native fixtures are
// `runtime_rich_channel::tests`; installed qualification is pending. None of this stands for the installed app.
const root = fileURLToPath(new URL('./fixtures/extensions/runtime-rich-channel/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'extension.json'), 'utf8')) as PreviewManifest & { permissions: string[]; contributes: { views: { id: string; title: string; text: string; rich: Record<string, unknown> }[] } };
const OWNER = 'sample.rich-channel';
const VIEW = 'sample.rich-channel/board';
const origin = { owner: OWNER, version: '1.0.0', viewId: VIEW };
const scripts = {
  channel: readFileSync(new URL('../src/extensions/rich-view-channel.js', import.meta.url), 'utf8'),
  host: readFileSync(new URL('../src/extensions/rich-view-host.js', import.meta.url), 'utf8'),
  client: readFileSync(new URL('../src/extensions/rich-view-client.js', import.meta.url), 'utf8'),
};
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const hello = (session: string) => ({ schemaVersion: 1, session, kind: 'hello' });
const post = (session: string, id: number, message: unknown) => ({ schemaVersion: 1, session, kind: 'post', id, message });
const value = (envelope: Envelope) => { if (!envelope.ok) throw new Error(envelope.error.message); return envelope.value as Record<string, any>; };

/** A shell the Node checks stand in for: what the host pushes to it is kept. */
function shell() { const received: any[] = []; return { received, frame: { contentWindow: { postMessage: (message: any) => received.push(message.detail) } as unknown as Window } }; }

async function boot(over: { grants?: Grants; service?: boolean } = {}) {
  const { createDaemon } = await import('./fixtures/extensions/backends/core/fake-daemon.mjs');
  let clock = 1000;
  let deliver: Parameters<DaemonFactory>[0] = () => undefined;
  const core = createDaemon({ now: () => clock, emit: (topic: string, frame: { event: string; seq: number; data: unknown }) => deliver(topic, frame), seed: { issues: [{ id: 'T-1', title: 'First' }, { id: 'T-2', title: 'Second' }] } });
  const daemon: DaemonFactory = emit => { deliver = emit; return core; };
  const panels = new PreviewPanelHost(() => clock);
  const grants: Grants = over.grants ?? new Map(manifest.permissions.map(name => [name, true as const]));
  const runtime = over.service === false ? { ...manifest.runtime, service: undefined } : manifest.runtime;
  const preview = createRuntimePreview({
    manifest: { ...manifest, runtime }, grants, daemon, now: () => clock, panels,
    loaders: { 'service.mjs': () => import('./fixtures/extensions/runtime-rich-channel/service.mjs') as Promise<ServiceModule> },
    settings: [{ id: OWNER, enabled: true, pages: [], stored: {} }],
  });
  const status = () => JSON.parse(preview.status.text ?? 'null');
  return { preview, panels, core, status, advance: (ms: number) => { clock += ms; } };
}

test('extensions rich channel: the fixture is a valid trusted panel package with a service and the twin keeps the native bounds', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(expect.arrayContaining(['ui.richViews', 'runtime.service']));
  const native = readFileSync(new URL('../src-tauri/src/extensions/runtime_rich_channel.rs', import.meta.url), 'utf8');
  expect(native).toContain('pub const MESSAGE_LIMIT: usize = 256 * 1024;');
  expect(native).toContain('pub const STATE_LIMIT: usize = 256 * 1024;');
  expect(native).toContain('pub const RATE_LIMIT: usize = 20;');
  expect(native).toContain(`pub const TOO_FAST: &str = "${TOO_FAST}";`);
  expect(native).toContain(`pub const SERVICE_ONLY: [&str; 9] = [${SERVICE_ONLY.map(name => `"${name}"`).join(', ')}];`);
  expect([MESSAGE_LIMIT, STATE_LIMIT, RATE_LIMIT, BODY_LIMIT]).toEqual([262144, 262144, 20, 262144 + 16384]);
  const fixture = readFileSync(join(root, 'service.mjs'), 'utf8');
  expect(fixture).not.toMatch(/\b(?:import|require)\b\s*[(\s'"]|\bprocess\b|\beval\b/);
});

test('extensions rich channel: two instances get distinct ids, shared B1 updates, visibility events and a targeted claim answer', async () => {
  const { preview, panels, core, status } = await boot();
  expect(await preview.start()).toEqual({ ok: true });
  const [a, b] = [shell(), shell()];
  panels.bind('extension-panel-a', a.frame, origin); panels.bind('extension-view-b', b.frame, origin);
  const first = value(panels.handle('extension-panel-a', hello('s-a')));
  const second = value(panels.handle('extension-view-b', hello('s-b')));
  expect(first.instanceId).not.toBe(second.instanceId);
  expect([first.placement, second.placement, first.restored]).toEqual(['inspector', 'window', false]);
  await settle();
  expect(status().opened).toEqual([first.instanceId, second.instanceId]);
  // Each opened instance got the board from the service, to that instance only.
  const boards = (frame: ReturnType<typeof shell>) => frame.received.filter(message => message.kind === 'message' && message.message.kind === 'board');
  expect([boards(a).length, boards(b).length]).toEqual([1, 1]);
  expect(boards(a)[0].session).toBe('s-a');
  // A change of the B1 board reaches both instances (one post, delivered twice).
  core.control('issues', { op: 'add', issue: { id: 'T-3', title: 'Third' } });
  await settle();
  expect([boards(a).length, boards(b).length]).toEqual([2, 2]);
  expect(boards(b).at(-1).message.issues.map((issue: { id: string }) => issue.id)).toEqual(['T-1', 'T-2', 'T-3']);
  expect(status().posted).toContain(2);
  // A claim from the window: the answer reaches only the window; the board change reaches both.
  expect(value(panels.handle('extension-view-b', post('s-b', 1, { kind: 'claim', issueId: 'T-1' })))).toEqual({ accepted: true });
  await settle();
  const claimed = (frame: ReturnType<typeof shell>) => frame.received.filter(message => message.kind === 'message' && message.message.kind === 'claimed');
  expect(claimed(b)).toHaveLength(1); expect(claimed(a)).toHaveLength(0);
  expect(claimed(b)[0].message.by).toBe(second.instanceId);
  expect(b.received.find(message => message.kind === 'reply')).toMatchObject({ id: 1, ok: true, value: null });
  expect(status().messages).toEqual([{ from: second.instanceId, kind: 'claim' }]);
  expect(boards(a).at(-1).message.issues.find((issue: { id: string }) => issue.id === 'T-1').status).toBe('in_progress');
  // Visibility: the panel and the service hear each change once.
  panels.setVisible('extension-panel-a', false); panels.setVisible('extension-panel-a', false);
  await settle();
  expect(a.received.filter(message => message.kind === 'visibility')).toEqual([expect.objectContaining({ visible: false })]);
  expect(status().hidden).toEqual([first.instanceId]);
  panels.setVisible('extension-panel-a', true); await settle();
  expect(status().visible).toEqual([first.instanceId]);
  expect(await preview.panelViews().instances(VIEW)).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: first.instanceId, windowId: 'main' }), expect.objectContaining({ instanceId: second.instanceId, windowId: 'extension-view-b' })]));
  await preview.stop();
});

test('extensions rich channel: state holds 256 KiB per instance and messages hold 256 KiB and 20 per second per package with actionable errors', async () => {
  const { preview, panels, advance } = await boot();
  await preview.start();
  const a = shell();
  panels.bind('extension-panel-a', a.frame, origin);
  value(panels.handle('extension-panel-a', hello('s')));
  const state = (data: unknown) => panels.handle('extension-panel-a', { schemaVersion: 1, session: 's', kind: 'state', value: data });
  const big = 'x'.repeat(STATE_LIMIT);
  const refused = state(big) as Extract<Envelope, { ok: false }>;
  expect(refused.error.code).toBe('LimitExceeded');
  expect(refused.error.message).toContain('256 KiB');
  expect(state('x'.repeat(STATE_LIMIT - 2)).ok).toBe(true);
  const large = panels.handle('extension-panel-a', post('s', 1, big)) as Extract<Envelope, { ok: false }>;
  expect([large.error.code, large.error.message.includes('chunks')]).toEqual(['LimitExceeded', true]);
  for (let id = 2; id < 2 + RATE_LIMIT * 2; id += 1) expect(panels.handle('extension-panel-a', post('s', id, { n: id })).ok).toBe(true);
  const fast = panels.handle('extension-panel-a', post('s', 99, { n: 99 })) as Extract<Envelope, { ok: false }>;
  expect(fast.error).toMatchObject({ code: 'LimitExceeded', message: TOO_FAST });
  advance(2000);
  expect(panels.handle('extension-panel-a', post('s', 100, { n: 100 })).ok).toBe(true);
  // The service side has its own window and the same size bound.
  const views = preview.panelViews();
  await expect(views.post(VIEW, big)).rejects.toMatchObject({ code: 'LimitExceeded' });
  // A reload of the panel (a new mount of the same inspector slot) gets the same instance and its state back.
  panels.bind('extension-panel-a', a.frame, origin)(true);
  panels.bind('extension-panel-c', shell().frame, origin);
  const again = value(panels.handle('extension-panel-c', hello('s2')));
  expect([again.restored, (again.state as string).length]).toEqual([true, STATE_LIMIT - 2]);
  await preview.stop();
});

test('extensions rich channel: closing drops pending messages and in-flight replies, and service-only calls answer UnsupportedCapability', async () => {
  const { preview, panels, status } = await boot();
  await preview.start();
  const w = shell();
  const dispose = panels.bind('extension-view-w', w.frame, origin);
  const init = value(panels.handle('extension-view-w', hello('s')));
  await settle();
  // The window is reloading: a post waits in its outbox, then closing drops it.
  panels.handle('extension-view-w', { schemaVersion: 1, session: 's', kind: 'bye' });
  const views = preview.panelViews();
  expect(await views.post(VIEW, { kind: 'board', revision: 9, issues: [] })).toEqual({ delivered: 1 });
  // Closed mid-response: the claim was accepted, the window closes before the service answers.
  expect(value(panels.handle('extension-view-w', post('s', 7, { kind: 'claim', issueId: 'T-2' })))).toEqual({ accepted: true });
  const before = w.received.length;
  dispose(false);
  await settle();
  expect(w.received.slice(before).filter(message => message.kind === 'reply' || message.kind === 'message')).toEqual([]);
  expect(status().closed).toEqual([init.instanceId]);
  expect(await views.post(VIEW, { kind: 'claimed' }, { instance: init.instanceId })).toEqual({ delivered: 0 });
  expect(await views.instances(VIEW)).toEqual([]);
  expect(panels.handle('extension-view-w', post('s', 8, {}))).toMatchObject({ ok: false, error: { message: CLOSED } });
  // Service-only calls from a panel's proxy: refused before anything runs.
  const p = shell();
  panels.bind('extension-panel-p', p.frame, origin);
  value(panels.handle('extension-panel-p', hello('p')));
  for (const path of ['secrets.get', 'auth.signIn', 'storage.directory', 'internal.invoke', 'events.on', 'hooks.on', 'modelTools.register', 'commands.register', 'views.post', 'providers.update']) {
    const answer = panels.handle('extension-panel-p', { schemaVersion: 1, session: 'p', kind: 'call', id: 1, path, args: [] }) as Extract<Envelope, { ok: false }>;
    expect(answer.error.code, path).toBe('UnsupportedCapability');
    expect(serviceOnly(path), path).toBe(true);
  }
  // A call the package holds runs through the same service SDK and answers the panel by id.
  expect(value(panels.handle('extension-panel-p', { schemaVersion: 1, session: 'p', kind: 'call', id: 2, path: 'settings.get', args: [{ page: `${OWNER}/missing` }] }))).toEqual({ accepted: true });
  await settle();
  expect(p.received.find(message => message.kind === 'reply' && message.id === 2)).toMatchObject({ ok: false });
  await preview.stop();
  // A package without a service: postMessage answers UnsupportedCapability.
  const bare = await boot({ service: false });
  const q = shell();
  bare.panels.bind('extension-panel-q', q.frame, origin);
  value(bare.panels.handle('extension-panel-q', hello('q')));
  bare.panels.handle('extension-panel-q', post('q', 1, {}));
  await settle();
  expect(q.received.find(message => message.kind === 'reply')).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', message: NO_SERVICE } });
});

test('extensions rich channel: shell requests are closed shapes bound to their session and the theme stays finite', () => {
  expect(parseRequest(hello('s'), 's')).toEqual({ kind: 'hello' });
  for (const forged of [hello('other'), { ...hello('s'), schemaVersion: 2 }, { ...hello('s'), kind: 'invoke' }, { ...hello('s'), command: 'read_file' }, post('s', 0, 1), { ...post('s', 1, 1), instance: 'x' }, { schemaVersion: 1, session: 's', kind: 'call', id: 1, path: '../x', args: [] }]) {
    expect(() => parseRequest(forged, 's'), JSON.stringify(forged)).toThrow();
  }
  expect(() => parseRequest(post('s', 1, 'x'.repeat(BODY_LIMIT)), 's')).toThrow(/^LimitExceeded/);
  expect([placementOf('extension-panel-a'), placementOf('extension-view-b'), placementOf('main')]).toEqual([['inspector', 'main'], ['window', 'extension-view-b'], undefined]);
  expect(validTheme({ schemaVersion: 1, colorScheme: 'dark', tokens: { '--accent': '#336699' } })).toBe(true);
  expect(validTheme({ schemaVersion: 1, colorScheme: 'url(x)' })).toBe(false);
  expect(themeFrom({ colorScheme: 'dark', tokens: { '--accent': '#336699', '--bg': 'rgb(0 0 0)', '--nope': '#000000' } })).toEqual({ schemaVersion: 1, colorScheme: 'dark', tokens: { '--accent': '#336699' } });
  // Dormant state is bounded and a theme reaches every initialized instance.
  const channel = new PanelChannel();
  channel.hello('extension-panel-a', 's', origin);
  expect(channel.setTheme({ schemaVersion: 1, colorScheme: 'light' })).toHaveLength(1);
  for (let index = 0; index < 70; index += 1) { channel.hello(`extension-panel-${index}`, 's', { ...origin, viewId: `${OWNER}/v${index}` }); channel.detach(`extension-panel-${index}`, true); }
  expect(channel.dormant()).toBe(64);
});

/** The real client in a VM: what it posts to its shell, and its `pandaView`. */
function client() {
  const listeners = new Map<string, (event: any) => void>(), sent: any[] = [];
  const parent = { postMessage: (message: any) => sent.push(message) };
  const context: Record<string, any> = {
    TextEncoder, URL,
    parent, addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback), removeEventListener() {},
    document: { getElementById: () => null, currentScript: { dataset: { pandaSession: 's' }, src: 'http://pandapanel.p00000000000000000000000000000000.localhost/~panda/client.js' }, documentElement: { dataset: {} } },
  };
  context.window = context;
  runInNewContext(`${scripts.channel}\n${scripts.client}`, context);
  const deliver = (data: unknown) => listeners.get('message')!({ source: parent, data });
  return { view: context.pandaView, sent, deliver };
}
const dto = { schemaVersion: 1, owner: OWNER, version: '1.0.0', viewId: VIEW, windowId: 'extension-panel-a', title: 'Channel board', text: 'Fallback' };

test('extensions rich channel: the client gives pandaView its instance, a bounded synchronous state, messages, visibility and a proxied SDK', async () => {
  const { view, sent, deliver } = client();
  expect(view.baseUrl).toBe('http://pandapanel.p00000000000000000000000000000000.localhost/');
  await expect(view.postMessage({ early: true })).rejects.toMatchObject({ code: 'UnsupportedCapability' });
  deliver({ schemaVersion: 1, session: 's', kind: 'init', sequence: 1, dto, theme: { schemaVersion: 1, colorScheme: 'dark' }, instance: { instanceId: 'i-1', viewId: VIEW, placement: 'inspector', restored: true, state: { selected: 'T-1' } } });
  expect([view.instanceId, view.viewId, view.state.get()]).toEqual(['i-1', VIEW, { selected: 'T-1' }]);
  let initialized: any; view.onDidInitialize((init: any) => { initialized = init; });
  expect([initialized.instanceId, initialized.placement, initialized.restored]).toEqual(['i-1', 'inspector', true]);
  // state.set is synchronous and throws LimitExceeded above 256 KiB; nothing is sent then.
  const count = sent.length;
  expect(() => view.state.set('x'.repeat(262145))).toThrow(/LimitExceeded: pandaView.state is at most 256 KiB/);
  expect(sent.length).toBe(count);
  view.state.set({ selected: 'T-2' });
  expect(sent.at(-1)).toEqual({ schemaVersion: 1, session: 's', kind: 'state', value: { selected: 'T-2' } });
  // postMessage: bounded, answered by id.
  await expect(view.postMessage('x'.repeat(262145))).rejects.toMatchObject({ code: 'LimitExceeded' });
  const posted = view.postMessage({ kind: 'claim' });
  const request = sent.at(-1);
  expect(request).toMatchObject({ kind: 'post', message: { kind: 'claim' } });
  deliver({ schemaVersion: 1, session: 's', kind: 'reply', id: request.id, ok: true, value: null });
  await expect(posted).resolves.toBeNull();
  const refused = view.postMessage({ kind: 'again' });
  deliver({ schemaVersion: 1, session: 's', kind: 'reply', id: sent.at(-1).id, ok: false, error: { schemaVersion: 1, code: 'LimitExceeded', message: TOO_FAST, path: '$', ids: [] } });
  await expect(refused).rejects.toMatchObject({ code: 'LimitExceeded', message: TOO_FAST });
  // Messages and visibility from the host; a forged kind or field is ignored.
  const messages: unknown[] = [], states: unknown[] = [];
  view.onMessage((message: unknown) => messages.push(message));
  view.onDidChangeVisibility((state: unknown) => states.push(state));
  deliver({ schemaVersion: 1, session: 's', kind: 'message', message: { n: 1 } });
  deliver({ schemaVersion: 1, session: 'other', kind: 'message', message: { n: 2 } });
  deliver({ schemaVersion: 1, session: 's', kind: 'invoke', command: 'read_file' });
  deliver({ schemaVersion: 1, session: 's', kind: 'visibility', visible: false, focused: false });
  expect(messages).toEqual([{ n: 1 }]);
  expect(states).toEqual([{ visible: false, focused: false }]);
  // The proxied SDK: service-only calls are refused in the panel; others go to the host by path.
  await expect(view.panda.secrets.get({ key: 'token' })).rejects.toMatchObject({ code: 'UnsupportedCapability' });
  await expect(view.panda.storage.directory({ scope: 'global' })).rejects.toMatchObject({ code: 'UnsupportedCapability' });
  void view.panda.tasks.queue.list('t1');
  expect(sent.at(-1)).toMatchObject({ kind: 'call', path: 'tasks.queue.list', args: ['t1'] });
  expect(sent.some(message => message.kind === 'call' && String(message.path).startsWith('secrets'))).toBe(false);
});

// ---- browser: the real shell and client framed from a package origin ------------------------------------------------

function folder(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(join(root, 'panel'))) files.set(name, readFileSync(join(root, 'panel', name)));
  return files;
}
async function servePanels(page: Page, key: string) {
  const mounts = new Map<string, PanelMount>();
  const served = new Map<string, PanelServed>([[key, { owner: OWNER, files: folder() }]]);
  await page.context().route(/^http:\/\/pandapanel\.p[0-9a-f]{32}\.localhost\//, async route => {
    const request = route.request(), url = request.url();
    const shellMount = previewMountFromUrl(url);
    if (shellMount) mounts.set(shellMount.label, shellMount.mount);
    let label = shellMount?.label ?? '';
    for (let frame = request.frame(); !label && frame; frame = frame.parentFrame()) label = /\/~panda\/shell\/([A-Za-z0-9-]+)/.exec(frame.url())?.[1] ?? '';
    const reply = await respondPanel({ label, uri: url, method: request.method(), mounts, served, scripts });
    await route.fulfill({ status: reply.status, headers: { 'content-type': reply.contentType, ...reply.headers }, body: typeof reply.body === 'string' ? reply.body : Buffer.from(reply.body) });
  });
}
const base64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

test('extensions rich channel: two framed instances stream the service board, claim through their own channel and keep state across a reload', async ({ page }) => {
  const key = await originKey(OWNER);
  await servePanels(page, key);
  await page.goto('/');
  const source = { kind: 'folder' as const, folder: 'panel', entry: 'index.html', remote: [] };
  const urls = ['extension-panel-a', 'extension-view-b'].map(label => `${shellUrl(key, label)}?config=${base64url(JSON.stringify(mountFor(OWNER, '1.0.0', manifest.contributes.views[0], source, label, { schemaVersion: 1, colorScheme: 'light' }, key, `session-${label}`)))}`);
  await page.evaluate(async ({ urls, origin, manifest }) => {
    const [{ previewPanelHost }, { createRuntimePreview }, { createDaemon }] = await Promise.all([
      import('/src/extensions/runtime-rich-channel.ts' as string), import('/src/extensions/runtime-preview.ts' as string), import('/tests/fixtures/extensions/backends/core/fake-daemon.mjs' as string),
    ]);
    const host = previewPanelHost();
    let deliver = (_topic: string, _frame: unknown) => undefined as unknown;
    const core = createDaemon({ emit: (topic: string, frame: unknown) => deliver(topic, frame), seed: { issues: [{ id: 'T-1', title: 'First' }, { id: 'T-2', title: 'Second' }] } });
    const preview = createRuntimePreview({
      manifest, panels: host, now: () => Date.now(), grants: new Map(manifest.permissions.map((name: string) => [name, true])),
      daemon: (emit: typeof deliver) => { deliver = emit; return core; },
      loaders: { 'service.mjs': () => import('/tests/fixtures/extensions/runtime-rich-channel/service.mjs' as string) },
    });
    await preview.start();
    const frames = urls.map((url: string, index: number) => {
      const frame = document.createElement('iframe');
      frame.id = `panel-${index}`; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.style.cssText = 'width:480px;height:320px';
      host.bind(index === 0 ? 'extension-panel-a' : 'extension-view-b', frame, origin);
      frame.src = url; document.body.append(frame);
      return frame;
    });
    Object.assign(window, { __channel: { host, preview, core, frames } });
  }, { urls, origin, manifest });
  const a = page.frameLocator('#panel-0').frameLocator('iframe'), b = page.frameLocator('#panel-1').frameLocator('iframe');
  await expect(a.locator('#instance')).toContainText(/instance: [0-9a-f-]{36} inspector/);
  await expect(b.locator('#instance')).toContainText(/instance: [0-9a-f-]{36} window/);
  expect(await a.locator('#instance').textContent()).not.toBe(await b.locator('#instance').textContent());
  await expect(a.locator('#board')).toHaveText('board: r2 T-1:open,T-2:open');
  await expect(b.locator('#board')).toHaveText('board: r2 T-1:open,T-2:open');
  await expect(a.locator('#visibility')).toHaveText('visibility: visible');
  // A claim from b: only b hears "claimed", both see the board change.
  await b.locator('#claim').click();
  await expect(b.locator('#claimed')).toHaveText('claimed: T-1 by me');
  await expect(a.locator('#board')).toHaveText('board: r3 T-1:in_progress,T-2:open');
  await expect(a.locator('#claimed')).toHaveText('claimed: none');
  // Visibility from the host, and the theme that follows the app.
  await page.evaluate(() => { const { host } = (window as any).__channel; host.setVisible('extension-panel-a', false); host.setTheme({ schemaVersion: 1, colorScheme: 'dark' }); });
  await expect(a.locator('#visibility')).toHaveText('visibility: hidden');
  await expect(b.locator('#theme')).toHaveText('theme: dark');
  // State: bounded and synchronous; kept when the window's document reloads.
  await a.locator('#oversized').click();
  await expect(a.locator('#error')).toHaveText('error: LimitExceeded');
  await b.locator('#remember').click();
  await expect(b.locator('#state')).toHaveText('state: {"selected":"T-1"}');
  await page.evaluate(() => { const frame = (window as any).__channel.frames[1] as HTMLIFrameElement; frame.src = frame.src; });
  await expect(b.locator('#restored')).toHaveText('restored: true');
  await expect(b.locator('#state')).toHaveText('state: {"selected":"T-1"}');
  // A service-only call from the panel's proxy.
  await a.locator('#secret').click();
  await expect(a.locator('#error')).toHaveText('error: UnsupportedCapability');
  const status = await page.evaluate(() => JSON.parse((window as any).__channel.preview.status.text));
  expect(status.opened).toHaveLength(2);
  expect(status.hidden).toHaveLength(1);
  expect(status.messages).toEqual([expect.objectContaining({ kind: 'claim' })]);
});
