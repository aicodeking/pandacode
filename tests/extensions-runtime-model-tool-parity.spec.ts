import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { checkModelToolDeclarations, ModelToolRegistry, type Entry as ModelEntry } from '../src/extensions/runtime-model-tools';
import { checkToolServerDeclarations, ToolServerRegistry, type Entry as ServerEntry } from '../src/extensions/runtime-tool-servers';
import {
  attach, Attachment, bridgeView, classifyError, CoreBridge, headerPlan, matrix, modeVerdict, offeredNames, outcomeJson, PATHS, pathCell, pruneResumed,
  row, SERVER_ATTACHMENT, serverOutcome, servedOutcome, shapeOf, stdioCarries, succeeded,
  type HeldStore, type Lookup, type Outcome, type Ports, type ToolHost,
} from '../src/extensions/runtime-model-tool-parity';
// Preview column of R0703 (package tools qualified across the provider paths). The browser preview runs no harness, so this
// spec runs in the test runner's Node: it drives the webview twin (src/extensions/runtime-model-tool-parity.ts) of the native
// module (src-tauri/src/extensions/runtime_model_tool_parity.rs, whose tests read the same scenarios.json) over the R0701 and
// R0702 twins and a fake held store. No harness runs and no real credential is used; the held values are synthetic sentinels.
const fixtures = new URL('./fixtures/extensions/runtime-model-tool-parity/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const scenarios = read('scenarios.json');
type Obj = Record<string, any>;
const OWNER = 'sample.parity';
const PROJECT = 'p1';
const sentinel: string = scenarios.sentinel;
const heldValues: Record<string, string> = scenarios.held;

interface World {
  models: ModelToolRegistry; servers: ToolServerRegistry; held: HeldStore & { uses: Obj[] };
  state: { enabled: boolean; projects: Set<string>; items: Set<string>; answer: (frame: Obj) => Promise<any> | null };
  holdsItem: Ports['holdsItem'];
}
function world(answer: World['state']['answer'] = frame => Promise.resolve({ content: { echo: frame.input } })): World {
  const state: World['state'] = { enabled: true, projects: new Set([PROJECT]), items: new Set(Object.keys(heldValues)), answer };
  const holds = (owner: string, _version: string, permission: string, project: string | null) => state.enabled && owner === OWNER && permission === 'tools.model' && (project === null ? state.projects.size > 0 : state.projects.has(project));
  const modelDeclarations = (checkModelToolDeclarations(manifest) as { ok: true; declarations: any[] }).declarations;
  const modelEntry: ModelEntry = { owner: OWNER, version: '1.0.0', packageName: 'Parity', declarations: modelDeclarations };
  const models = new ModelToolRegistry({ source: () => (state.enabled ? [modelEntry] : []), holds, ask: (_owner, frame) => state.answer(frame) });
  const serverDeclarations = (checkToolServerDeclarations(manifest) as { ok: true; declarations: any[] }).declarations;
  const serverEntry: ServerEntry = { owner: OWNER, version: '1.0.0', packageName: 'Parity', declarations: serverDeclarations, packageDir: () => 'C:/code/sample.parity' };
  const servers = new ToolServerRegistry({ source: () => (state.enabled ? [serverEntry] : []), holds: (owner, version, permission, project) => holds(owner, version, permission, project), probe: () => ({ ok: true, tools: ['docs_search'] }), node: () => 'C:/runtime/node.exe' });
  const uses: Obj[] = [];
  const held: HeldStore & { uses: Obj[] } = {
    uses,
    use(owner, version, item, address) {
      const value = heldValues[item];
      if (value === undefined) return { ok: false, code: 'NotFound' };
      uses.push({ kind: 'credential.use', item, address, package: owner, version });
      return { ok: true, value };
    },
  };
  return { models, servers, held, state, holdsItem: (owner, _version, item) => owner === OWNER && state.items.has(item) };
}
const registerAll = (w: World) => { for (const tool of ['recall', 'quiet', 'big_dump']) expect(w.models.register(OWNER, `${OWNER}/${tool}`).ok).toBe(true); };
const ports = (w: World): Ports => ({ servers: w.servers, held: w.held, holdsItem: w.holdsItem });

/** The run's tool host as the app leaves it: one app tool and the listed package tools; the handler serves a package tool through the registry and records the `tool.after` the result hooks deliver. */
function hostOf(w: World, trace: Obj[]): ToolHost {
  const listed = w.models.listed(PROJECT);
  const names = new Set(listed.map(tool => tool.declaration.name));
  const tools: Obj[] = [{ type: 'function', name: 'pandacode_preview_file', description: 'Open a preview.', inputSchema: { type: 'object' } },
    ...listed.map(tool => ({ type: 'function', name: tool.declaration.name, description: tool.declaration.description, inputSchema: tool.declaration.inputSchema }))];
  return {
    tools,
    approvalTools: new Set(listed.filter(tool => tool.declaration.approval !== 'never').map(tool => tool.declaration.name)),
    async handler(name, input) {
      if (!names.has(name)) return { ok: true, value: { core: true } };
      const result = await w.models.call(PROJECT, name, input, { callId: 'model-0', taskId: 't1', projectId: PROJECT });
      trace.push({ event: 'tool.after', tool: name, ok: result.ok });
      return result.ok ? (result.served.isError ? { ok: false, line: String(result.served.content) } : { ok: true, value: result.served.content }) : { ok: false, line: result.error.message };
    },
  };
}
function bridgeOf(w: World, trace: Obj[], mode: string, allow: boolean, approve = true): CoreBridge {
  const resolve = (name: string): Lookup => {
    const listed = w.models.listed(PROJECT).find(tool => tool.declaration.name === name);
    if (listed) return { kind: 'package', owner: listed.owner };
    return ['recall', 'quiet', 'big_dump'].includes(name) ? { kind: 'gone' } : { kind: 'core' };
  };
  return new CoreBridge(hostOf(w, trace), resolve, approve ? () => modeVerdict(mode, allow) : null, trace);
}

test('every path kind is a run kind and unsupported harnesses say why', () => {
  const kinds = new Set(['task', 'worker', 'bot', 'schedule', 'remote']);
  expect(PATHS.every(path => kinds.has(path.kind))).toBe(true);
  for (const kind of kinds) expect(PATHS.some(path => path.kind === kind), kind).toBe(true);
  for (const expected of scenarios.capabilities) {
    const label = expected.harness;
    const found = row(label, expected.package);
    expect(found.family, label).toBe(expected.family);
    for (const key of ['modelTools', 'toolServers'] as const) {
      expect(found[key].support, `${label} ${key}`).toBe(expected[key].support);
      expect(found[key].qualification, `${label} ${key}`).toBe(expected[key].qualification);
      if (expected[key].support === 'unsupported') {
        expect(found[key].code, `${label} ${key}`).toBe('UnsupportedCapability');
        expect(typeof found[key].reason, `${label} ${key}`).toBe('string');
      }
    }
    expect(shapeOf(label, expected.package), label).toBe(expected.shape);
  }
  expect(row('claude', false).toolServers.qualification).not.toBe('recorded');
  expect(row('claude', false).toolServers.attachment).toBe(SERVER_ATTACHMENT);
});

test('a mirrored run executes nothing here', () => {
  const mirror = PATHS.find(path => path.trigger === 'mirror')!;
  const found = pathCell('claude', false, mirror);
  expect((found.modelTools as Obj).support).toBe('unsupported');
  expect((found.toolServers as Obj).code).toBe('UnsupportedCapability');
  expect(matrix([['claude', false], ['kimi', false]])).toHaveLength(2 * PATHS.length);
});

test('each supported run path discovers and invokes the package tool, and attaches the servers of its harness', async () => {
  for (const path of scenarios.paths) {
    const label = path.id;
    const w = world();
    registerAll(w);
    const trace: Obj[] = [];
    const bridge = bridgeOf(w, trace, path.mode, true);
    const listed = bridge.list();
    const recall = listed.find(tool => tool.name === 'recall');
    expect(recall, `${label}: discovered`).toBeTruthy();
    expect([recall!.owner, recall!.needsApproval], label).toEqual([OWNER, true]);
    expect(listed.find(tool => tool.name === 'quiet')!.needsApproval, label).toBe(false);
    expect(listed.some(tool => tool.owner === null), label).toBe(true);

    const outcome = await bridge.call('run-1', 'task', path.mode, 'recall', { query: 'pnpm' });
    if (path.expect === 'denied') {
      expect([outcome.status, outcome.executed, outcome.code], label).toEqual(['refused', 'no', 'PermissionDenied']);
      expect(trace.some(event => event.event === 'tool.after'), `${label}: a denied tool never runs`).toBe(false);
    } else {
      expect(succeeded(outcome), `${label}: ${JSON.stringify(outcome)}`).toBe(true);
      expect((outcome.result as Obj).echo.query, label).toBe('pnpm');
      expect(trace.map(event => event.event), `${label}: the approval and the hook are the model tool's own`).toEqual(['tool.before', 'tool.after']);
    }
    expect(succeeded(await bridge.call('run-1', 'task', path.mode, 'quiet', {})), `${label}: a tool declared without approval is not asked`).toBe(true);
    expect(succeeded(await bridge.call('run-1', 'task', path.mode, 'pandacode_preview_file', {})), `${label}: the app's own tool`).toBe(true);

    const shape = shapeOf(path.harness, false)!;
    w.servers.attachRun('run-1', PROJECT, 'C:/work/p1');
    const attached = attach(ports(w), 'run-1', PROJECT, shape);
    const byName = (name: string) => attached.entries().find(entry => entry.name === name)?.entry as Obj;
    expect(attached.entries(), label).toHaveLength(4);
    expect(JSON.stringify(byName('pkg_sample_parity__secured')), `${label}: bearer header`).toContain(`Bearer ${heldValues['provider:glm']}`);
    const keyed = JSON.stringify(byName('pkg_sample_parity__keyed'));
    expect(keyed.includes('X-Docs-Key') && keyed.includes(heldValues['connection:docs']), `${label}: declared header`).toBe(true);
    expect(stdioCarries(attached.entries(), sentinel) || stdioCarries(attached.entries(), 'Bearer'), `${label}: a stdio server never receives a held value`).toBe(false);
    const everything = `${JSON.stringify(attached)}${JSON.stringify(attached.states)}${JSON.stringify(attached.publicEntries())}${JSON.stringify(trace)}${JSON.stringify(w.held.uses)}`;
    for (const value of Object.values(heldValues)) expect(everything.includes(value), `${label}: a held value leaked into a public form`).toBe(false);
    w.servers.detachRun('run-1');
  }
});

test('a stdio server gets no value in any shape and no header plan', () => {
  const w = world();
  w.servers.attachRun('run-1', PROJECT, '');
  for (const shape of ['claude', 'codex', 'acp'] as const) {
    const attached = attach(ports(w), 'run-1', PROJECT, shape);
    const local = attached.entries().find(entry => entry.name === 'pkg_sample_parity__local')!.entry as Obj;
    expect(local.env === undefined || JSON.stringify(local.env) === '{}' || JSON.stringify(local.env) === '[]', shape).toBe(true);
    expect(local.headers === undefined && local.http_headers === undefined, shape).toBe(true);
    for (const value of Object.values(heldValues)) expect(stdioCarries(attached.entries(), value), shape).toBe(false);
  }
  const declarations = (checkToolServerDeclarations(manifest) as { ok: true; declarations: any[] }).declarations;
  expect(headerPlan(declarations[0])).toEqual({ ok: true, plan: null });
  expect(headerPlan({ ...declarations[0], authentication: 'bearer' })).toEqual({ ok: true, plan: null });
});

test('the credential is attached only when declared, granted and held, and every use is recorded without its value', () => {
  const w = world();
  w.servers.attachRun('run-1', PROJECT, '');
  const stateOf = (attached: Attachment, id: string) => attached.states.find(state => state.id === id) as Obj;
  const attached = attach(ports(w), 'run-1', PROJECT, 'claude');
  expect(stateOf(attached, 'sample.parity/secured').state).toBe('attached');
  expect(stateOf(attached, 'sample.parity/secured').credential).toEqual({ item: 'provider:glm', header: 'Authorization', state: 'attached' });
  expect(w.held.uses).toHaveLength(2);
  expect(w.held.uses.every(use => use.kind === 'credential.use' && use.package === OWNER && (String(use.address).startsWith('https://docs.example.com') || String(use.address).startsWith('https://keyed.example.com/mcp')))).toBe(true);
  expect(w.held.uses.some(use => String(use.address).includes('team=blue')), 'the query is not kept').toBe(false);
  expect(JSON.stringify(w.held.uses).includes(sentinel)).toBe(false);

  w.state.items.delete('provider:glm');
  const denied = attach(ports(w), 'run-1', PROJECT, 'claude');
  expect(stateOf(denied, 'sample.parity/secured').state).toBe('credentialDenied');
  expect(denied.names()).not.toContain('pkg_sample_parity__secured');
  expect(w.held.uses).toHaveLength(3);

  const none: HeldStore = { use: () => ({ ok: false, code: 'NotFound' }) };
  expect(stateOf(attach({ ...ports(w), held: none, holdsItem: () => true }, 'run-1', PROJECT, 'codex'), 'sample.parity/keyed').state).toBe('credentialMissing');

  const [, , , keyed] = (checkToolServerDeclarations(manifest) as { ok: true; declarations: any[] }).declarations;
  expect(headerPlan({ ...keyed, credential: { source: 'secret', key: 'docs-token' } })).toEqual({ ok: false, code: 'UnsupportedCapability' });
  expect(headerPlan({ ...keyed, credential: { source: 'held', id: 'connection:docs', header: 'Bad Header' } })).toEqual({ ok: false, code: 'InvalidShape' });
});

test('a revoked grant, a disable or safe mode leave no attachment', () => {
  const w = world();
  w.servers.attachRun('run-1', PROJECT, '');
  expect(attach({ ...ports(w), holdsItem: () => true }, 'run-1', PROJECT, 'claude').entries()).toHaveLength(4);
  w.state.enabled = false;
  w.servers.reconcile();
  const gone = attach({ ...ports(w), holdsItem: () => true }, 'run-1', PROJECT, 'claude');
  expect(gone.entries()).toHaveLength(0);
  expect(gone.states).toHaveLength(0);
});

test('disable and revoke keep the inventory and the execution coherent', async () => {
  const w = world();
  registerAll(w);
  const trace: Obj[] = [];
  const bridge = bridgeOf(w, trace, 'ask', true);
  expect(succeeded(await bridge.call('run-1', 'task', 'ask', 'recall', { query: 'a' }))).toBe(true);
  w.state.projects.clear();
  expect(bridge.list().every(tool => tool.name !== 'recall' && tool.name !== 'quiet'), 'a revoked grant removes the listing').toBe(true);
  const refused = await bridge.call('run-1', 'task', 'ask', 'recall', { query: 'a' });
  expect([refused.status, refused.executed, refused.code]).toEqual(['refused', 'no', 'NotFound']);
  expect(succeeded(await bridge.call('run-1', 'task', 'ask', 'pandacode_preview_file', {})), "the app's own tools stay").toBe(true);
  w.state.projects.add(PROJECT);
  w.state.enabled = false;
  expect(bridge.list().every(tool => tool.name !== 'recall'), 'a disabled package is not listed').toBe(true);
  expect((await bridge.call('run-1', 'task', 'ask', 'quiet', {})).executed).toBe('no');
});

test('approval modes apply to a provider call like to the models', async () => {
  const w = world();
  registerAll(w);
  const run = (mode: string, allow: boolean, approve = true) => bridgeOf(w, [], mode, allow, approve).call('run-1', 'task', mode, 'recall', { query: 'a' });
  expect((await run('plan', true)).code).toBe('PermissionDenied');
  expect((await run('ask', false)).code).toBe('PermissionDenied');
  expect(succeeded(await run('full', false))).toBe(true);
  const nobody = await run('ask', true, false);
  expect([nobody.status, nobody.executed]).toEqual(['unavailable', 'no']);
});

test('truncation and reconnect never claim an unexecuted tool succeeded', async () => {
  const big = world(() => Promise.resolve({ content: 'x'.repeat(65 * 1024) }));
  registerAll(big);
  const cut = await big.models.call(PROJECT, 'big_dump', {}, {});
  const truncated: Outcome = cut.ok ? servedOutcome(cut.served) : classifyError(cut.error);
  expect([truncated.status, truncated.executed, truncated.delivered, succeeded(truncated)]).toEqual(['truncated', 'yes', false, false]);

  let asked = 0;
  const dropped = world(() => { asked += 1; return Promise.reject(new Error('the service stopped')); });
  registerAll(dropped);
  const stopped = await dropped.models.call(PROJECT, 'quiet', {}, {});
  const interrupted: Outcome = stopped.ok ? servedOutcome(stopped.served) : classifyError(stopped.error);
  expect([interrupted.status, interrupted.executed, succeeded(interrupted)]).toEqual(['interrupted', 'unknown', false]);
  expect(asked).toBe(1);
  dropped.models.removeOwner(OWNER);
  const gone = await dropped.models.call(PROJECT, 'quiet', {}, {});
  const unavailable: Outcome = gone.ok ? servedOutcome(gone.served) : classifyError(gone.error);
  expect([unavailable.status, unavailable.executed]).toEqual(['unavailable', 'no']);
  expect(asked, 'the host never runs a tool again behind the model').toBe(1);

  for (const scripted of scenarios.serverRows) {
    const outcome = serverOutcome(scripted.row);
    expect([outcome.status, outcome.executed, succeeded(outcome)], scripted.id).toEqual([scripted.status, scripted.executed, scripted.succeeded]);
    expect(JSON.stringify(outcomeJson(outcome)).includes('secret-output'), `${scripted.id}: the recorder form carries no result`).toBe(false);
  }
});

test('a resumed session loses the names of a disabled package and the bridge becomes the zero-extension one', () => {
  const w = world();
  registerAll(w);
  w.servers.attachRun('run-1', PROJECT, '');
  const all = { ...ports(w), holdsItem: () => true };
  const before = offeredNames(w.models, w.servers, attach(all, 'run-1', PROJECT, 'claude'), 'run-1', PROJECT);
  for (const name of ['recall', 'mcp__pkg_sample_parity__local__docs_search', 'mcp__pkg_sample_parity__secured__*']) expect(before.has(name), name).toBe(true);
  expect(bridgeView(before).zeroExtension).toBe(false);
  const previous = ['pandacode_preview_file', 'recall', 'mcp__pkg_sample_parity__local__docs_search', 'mcp__other__tool'];
  const known = new Set(['recall', 'quiet']);
  expect(pruneResumed(previous, known, before).removed).toEqual([]);

  w.state.enabled = false;
  w.servers.reconcile();
  const after = offeredNames(w.models, w.servers, attach(all, 'run-1', PROJECT, 'claude'), 'run-1', PROJECT);
  expect(after.size).toBe(0);
  expect(bridgeView(after)).toEqual({ zeroExtension: true, modelTools: [], toolServers: [] });
  expect(pruneResumed(previous, known, after)).toEqual({ kept: ['pandacode_preview_file', 'mcp__other__tool'], removed: ['recall', 'mcp__pkg_sample_parity__local__docs_search'] });
});
