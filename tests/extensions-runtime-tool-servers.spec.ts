import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import {
  checkToolServerDeclarations, MAX_ATTEMPTS, MAX_ERROR, placeholdersKnown, resolveCommand, serverName, ToolServerRegistry, validUrl,
  type Entry, type Probe,
} from '../src/extensions/runtime-tool-servers';
// Preview column of R0702 (declared tool servers started and attached per run). The browser preview runs no harness, so
// this spec runs in the test runner's Node: it checks the declarations and refusals through the webview twin
// (src/extensions/runtime-tool-servers.ts) of the native module (src-tauri/src/extensions/runtime_tool_servers.rs, whose
// tests read the same cases.json), and drives the real fixture server (server/index.mjs, a stdio MCP server) through a
// Node handshake that stands for the host's probe. No harness and no real runtime run here; held-header attachment
// of http servers belongs to R0703.
const fixtures = new URL('./fixtures/extensions/runtime-tool-servers/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const cases = read('cases.json');
type Obj = Record<string, any>;
const OWNER = 'sample.docs';
const serverOf = (id: string): Obj => structuredClone(manifest.contributes.toolServers.find((server: Obj) => server.id === id));

function refusalManifest(scripted: Obj): Obj {
  const changed = serverOf(scripted.base ?? 'sample.docs/local');
  for (const [key, value] of Object.entries(scripted.set ?? {})) changed[key] = value;
  for (const key of scripted.drop ?? []) delete changed[key];
  let servers = [changed];
  for (const extra of scripted.extra ?? []) { const more = structuredClone(changed); for (const [key, value] of Object.entries(extra.set ?? {})) more[key] = value; servers.push(more); }
  if (scripted.count) servers = Array.from({ length: scripted.count }, (_, index) => ({ ...serverOf('sample.docs/local'), id: `${OWNER}/s${index}` }));
  const copy = structuredClone(manifest);
  copy.contributes.toolServers = servers;
  if (scripted.permissions) copy.permissions = scripted.permissions;
  return copy;
}

test('the fixture manifest declares valid tool servers and the validator agrees', () => {
  const checked = checkToolServerDeclarations(manifest);
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.declarations.map(declaration => declaration.id)).toEqual(['sample.docs/local', 'sample.docs/hosted', 'sample.docs/silent', 'sample.docs/secured']);
  expect(checked.declarations.map(declaration => declaration.authentication)).toEqual(['none', 'none', 'none', 'bearer']);
  expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
});

test('every refusal answers the code the native check answers', () => {
  for (const scripted of cases.refusals) {
    const checked = checkToolServerDeclarations(refusalManifest(scripted));
    expect(checked.ok, scripted.id).toBe(false);
    if (checked.ok) continue;
    expect({ code: checked.refusal.code, at: checked.refusal.at }, scripted.id).toEqual(scripted.expect);
  }
});

test('placeholders, addresses and the resolved command', () => {
  for (const scripted of cases.placeholders) expect(placeholdersKnown(scripted.part), scripted.part).toBe(scripted.ok);
  for (const scripted of cases.urls) expect(validUrl(scripted.url), scripted.url).toBe(scripted.ok);
  expect(resolveCommand(['{node}', '{package}/a.mjs'], 'n', 'p')).toEqual(['n', 'p/a.mjs']);
  expect(resolveCommand(['{node}'], null, 'p')).toBeNull();
  expect(serverName('sample.docs/local')).toBe('pkg_sample_docs__local');
  expect(serverName(`a.b/${'x'.repeat(80)}`).length).toBeLessThanOrEqual(48);
});

/** The handshake the host runs: initialize, then tools/list, newline-delimited JSON-RPC, 3 s here. */
function handshake(argv: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 3_000);
    const send = (value: Obj) => child.stdin.write(`${JSON.stringify(value)}\n`);
    createInterface({ input: child.stdout }).on('line', line => {
      const frame = JSON.parse(line);
      if (frame.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
      if (frame.id === 2) { clearTimeout(timer); child.kill(); resolve(frame.result.tools.map((tool: Obj) => tool.name)); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pandacode', version: '1' } } });
  });
}

const packageDir = fileURLToPath(fixtures).replace(/[\\/]$/, '');
function registryWith(grants: Set<string>, probeOf: (argv: string[]) => ReturnType<Probe>) {
  const declarations = (checkToolServerDeclarations(manifest) as { ok: true; declarations: any[] }).declarations;
  const entry: Entry = { owner: OWNER, version: '1.0.0', packageName: 'Docs', declarations, packageDir: () => packageDir };
  return new ToolServerRegistry({ source: () => [entry], holds: (owner, _version, permission, project) => owner === OWNER && permission === 'tools.model' && grants.has(project), probe: argv => probeOf(argv), node: () => process.execPath });
}

test('a server is advertised only to the projects that hold the grant, with bounded failure state', () => {
  const registry = registryWith(new Set(['p1']), argv => (argv.some(part => part.includes('silent')) ? { ok: false, code: 'Timeout' } : { ok: true, tools: ['docs_search', 'docs_read'] }));
  expect(registry.listed('p1')).toHaveLength(4);
  expect(registry.listed('p2')).toHaveLength(0);
  expect(registry.attachRun('run-2', 'p2')).toEqual([]);
  const states = Object.fromEntries(registry.attachRun('run-1', 'p1', '').map(slot => [slot.id, slot]));
  expect(states['sample.docs/local'].state).toBe('attached');
  expect(states['sample.docs/local'].tools).toEqual(['docs_search', 'docs_read']);
  expect(states['sample.docs/hosted'].state).toBe('attached');
  expect(states['sample.docs/silent'].state).toBe('failed');
  expect(states['sample.docs/silent'].error!.length).toBeLessThanOrEqual(MAX_ERROR);
  expect(states['sample.docs/secured'].state).toBe('credentialPending');
});

test('start, stop and restart move one slot and stay bounded', () => {
  const registry = registryWith(new Set(['p1']), () => ({ ok: true, tools: ['docs_search'] }));
  registry.attachRun('run-1', 'p1');
  const stopped = registry.stop('run-1', 'sample.docs/local');
  expect(stopped.ok && stopped.slot.state).toBe('stopped');
  expect(registry.tools('run-1')['sample.docs/local']).toBeUndefined();
  const started = registry.start('run-1', 'sample.docs/local');
  expect(started.ok && started.slot.state).toBe('attached');
  let last: ReturnType<typeof registry.restart> = started;
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) last = registry.restart('run-1', 'sample.docs/local');
  expect(last).toEqual({ ok: false, code: 'LimitExceeded' });
  expect(registry.stop('run-1', 'sample.docs/ghost')).toEqual({ ok: false, code: 'NotFound' });
});

test('revoking one project grant removes only its attachments and leaves the other run alone', () => {
  const grants = new Set(['p1', 'p2']);
  const registry = registryWith(grants, () => ({ ok: true, tools: ['docs_search'] }));
  registry.attachRun('run-1', 'p1');
  registry.attachRun('run-2', 'p2');
  const before = registry.attachedCount();
  grants.delete('p1');
  const removed = registry.reconcile();
  expect(removed.length).toBeGreaterThan(0);
  expect(removed.every(item => item.run === 'run-1')).toBe(true);
  expect(registry.state('run-1')).toEqual([]);
  expect(Object.keys(registry.tools('run-2'))).toHaveLength(2);
  expect(registry.attachedCount()).toBeLessThan(before);
  registry.detachRun('run-2');
  expect(registry.attachedCount()).toBe(0);
});

test('the real fixture server answers the handshake and its entries carry the package and no held value', async () => {
  const tools = await handshake([process.execPath, `${packageDir}/server/index.mjs`], '');
  expect(tools).toEqual(cases.runs.expectTools['sample.docs/local']);
  await expect(handshake([process.execPath, `${packageDir}/server/silent.mjs`], '')).rejects.toThrow('Timeout');
  const registry = registryWith(new Set(['p1']), () => ({ ok: true, tools }));
  registry.attachRun('run-1', 'p1');
  const entries = registry.mcpEntries('run-1', 'claude');
  expect(entries.map(item => item.name).sort()).toEqual(['pkg_sample_docs__hosted', 'pkg_sample_docs__local', 'pkg_sample_docs__silent']);
  const local = entries.find(item => item.name === 'pkg_sample_docs__local')!.entry;
  expect(local.env).toEqual({});
  for (const shape of ['claude', 'codex', 'acp'] as const) expect(JSON.stringify(registry.mcpEntries('run-1', shape))).not.toMatch(/Authorization|docs-token/);
  expect(registry.attribution('run-1', 'mcp__pkg_sample_docs__local__docs_search')).toEqual({ packageName: 'Docs', title: 'Docs' });
  expect(registry.attribution('run-1', 'mcp__nobody__x')).toBeNull();
});
