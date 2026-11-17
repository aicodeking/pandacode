import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import {
  attributedRow, checkModelToolDeclarations, coreToolsList, DEFAULT_TIMEOUT_MS, envelope, hostToolSpec, inputProblem, MAX_RESULT_BYTES, modelResult,
  ModelToolRegistry, PERMISSION, resolve, type Entry, type Wiring,
} from '../src/extensions/runtime-model-tools';
// Preview column of R0701 (declared model tools served by a package's service). The browser preview runs no harness, so
// this spec runs in the test runner's Node: it checks the declarations and refusals through the webview twin
// (src/extensions/runtime-model-tools.ts) of the native module (src-tauri/src/extensions/runtime_model_tools.rs, whose
// tests read the same cases.json), and drives the fixture service (main.cjs) through a stand-in of the service SDK and
// of the per-run tool server: a scripted harness (synthetic frames) lists the fixture tools, calls them and receives
// what the host builds. No real harness runs here, and ZCode's per-session bridge (decision A5) is not wired.
const fixtures = new URL('./fixtures/extensions/runtime-model-tools/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const cases = read('cases.json');
type Obj = Record<string, any>;
const OWNER = 'sample.memory';

/** `"{pad:N}"` anywhere in a fixture stands for N characters. */
function expand(value: any): any {
  if (typeof value === 'string') { const match = /^\{pad:(\d+)\}$/.exec(value); return match ? 'x'.repeat(Number(match[1])) : value; }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  return value;
}
const base = (name: string): Obj => structuredClone(manifest.contributes.modelTools.find((tool: Obj) => tool.name === name));
function refusalManifest(scripted: Obj): Obj {
  const changed = base('memory');
  for (const [key, value] of Object.entries(scripted.set ?? {})) changed[key] = expand(value);
  for (const key of scripted.drop ?? []) delete changed[key];
  let tools = [changed];
  for (const extra of scripted.extra ?? []) { const more = structuredClone(changed); for (const [key, value] of Object.entries(extra.set ?? {})) more[key] = expand(value); tools.push(more); }
  if (scripted.count) tools = Array.from({ length: scripted.count }, (_, index) => ({ ...base('memory'), id: `${OWNER}/t${index}`, name: `t${index}` }));
  const copy = structuredClone(manifest);
  copy.contributes.modelTools = tools;
  if (scripted.permissions) copy.permissions = scripted.permissions;
  if (scripted.noService) delete copy.runtime.service;
  return copy;
}

/** The fixture service behind a stand-in SDK: `ask` hands a model-tool frame to the registered handler. */
async function startService() {
  const require = createRequire(import.meta.url);
  const main = require(fileURLToPath(new URL('main.cjs', fixtures)));
  const handlers = new Map<string, (input: Obj, call: Obj) => unknown>();
  const commands = new Map<string, (context: Obj) => Promise<unknown>>();
  const panda = {
    modelTools: { register: (id: string, handler: (input: Obj, call: Obj) => unknown) => { handlers.set(id, handler); return { dispose: () => handlers.delete(id) }; } },
    commands: { register: (id: string, handler: (context: Obj) => Promise<unknown>) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; } },
  };
  let stop = () => {};
  await main.service(panda, { onStop: (handler: () => void) => { stop = handler; } });
  return { handlers, commands, stop: () => stop() };
}

const declarations = (checkModelToolDeclarations(manifest) as { declarations: any[] }).declarations;
function wired(options: { granted?: boolean; enabled?: boolean; service?: Awaited<ReturnType<typeof startService>> } = {}) {
  const { granted = true, enabled = true, service } = options;
  const entries: Entry[] = enabled ? [{ owner: OWNER, version: '1.0.0', packageName: 'Memory', declarations }] : [];
  const wiring: Wiring = {
    source: () => entries,
    holds: (owner, _version, permission) => granted && owner === OWNER && permission === PERMISSION,
    ask: (owner, frame) => {
      const handler = service?.handlers.get(frame.toolId as string);
      return owner === OWNER && handler ? Promise.resolve(handler(frame.input as Obj, frame.call as Obj)) as Promise<any> : null;
    },
  };
  return { registry: new ModelToolRegistry(wiring), wiring, entries };
}
const context = { callId: 'model-0', taskId: 't1', projectId: 'p1', projectRoot: '/work/p1', cwd: '/work/p1', harness: 'fake-acp', model: null, mode: 'ask', run: { kind: 'task' } };

test.describe('extensions model tools: R0701 served by a package service', () => {
  test('the fixture package is valid and declares the model tools', () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect(declarations.map(declaration => declaration.name)).toEqual(['memory', 'slow_recall', 'big_dump', 'bare_value', 'broken']);
    expect(declarations.map(declaration => declaration.timeoutMs)).toEqual([DEFAULT_TIMEOUT_MS, 100, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS]);
    expect(declarations.map(declaration => declaration.approval)).toEqual(['mode', 'mode', 'mode', 'mode', 'never']);
  });

  for (const scripted of cases.refusals as Obj[]) {
    test(`refusal: ${scripted.id}`, () => {
      const result = checkModelToolDeclarations(refusalManifest(scripted)) as Obj;
      expect(result.ok).toBe(false);
      expect({ code: result.refusal.code, at: result.refusal.at, ids: result.refusal.ids }).toEqual(scripted.expect);
      // The contract validator refuses the same manifest with the same code.
      const contract = validateContract('packages', [refusalManifest(scripted)]) as Obj;
      expect(contract.ok).toBe(false);
      expect(JSON.stringify(contract)).toContain(scripted.expect.code);
    });
  }

  test('arguments are checked against the declared schema', () => {
    const schema = base('memory').inputSchema;
    for (const scripted of cases.inputs as Obj[]) expect(inputProblem(schema, expand(scripted.input)) === null, scripted.id).toBe(scripted.valid);
  });

  test('a handler answers the envelope, bounded to 64 KiB of compact JSON', () => {
    for (const scripted of cases.envelopes as Obj[]) {
      const result = envelope(expand(scripted.answer));
      if (scripted.expect.code) expect(result, scripted.id).toEqual({ ok: false, code: scripted.expect.code });
      else expect(result, scripted.id).toEqual({ ok: true, content: expand(scripted.expect.content), isError: scripted.expect.isError });
    }
    expect(MAX_RESULT_BYTES).toBe(65_536);
  });

  test('the package that comes later loses a shared name and is not listed', () => {
    for (const scripted of cases.collisions as Obj[]) {
      const entries: Entry[] = scripted.entries.map((entry: Obj) => ({
        owner: entry.owner, version: '1.0.0', packageName: entry.owner,
        declarations: entry.names.map((name: string) => ({ ...declarations[0], id: `${entry.owner}/${name}`, name })),
      }));
      const { available, conflicts } = resolve(entries);
      expect(available.map(listed => [listed.owner, listed.declaration.name]), scripted.id).toEqual(scripted.available);
      expect(conflicts.map(conflict => [conflict.owner, conflict.name, conflict.heldBy]), scripted.id).toEqual(scripted.conflicts);
    }
  });

  test('registering needs a declared id, the grant, and one handler per id', async () => {
    const service = await startService();
    const { registry } = wired({ service });
    expect(registry.register(OWNER, 'sample.memory/ghost')).toEqual({ ok: false, code: 'UnknownReference' });
    expect(registry.register('sample.other', 'sample.memory/memory')).toEqual({ ok: false, code: 'HostUnavailable' });
    expect(registry.register(OWNER, 'sample.memory/memory')).toMatchObject({ ok: true, value: { name: 'memory', available: true } });
    expect(registry.register(OWNER, 'sample.memory/memory')).toEqual({ ok: false, code: 'DuplicateId' });
    expect(wired({ granted: false, service }).registry.register(OWNER, 'sample.memory/memory')).toEqual({ ok: false, code: 'PermissionDenied' });
    expect(registry.removeOwner(OWNER)).toBe(1);
    expect(registry.registered(OWNER, 'sample.memory/memory')).toBe(false);
  });

  test('a recorded harness lists a fixture tool, calls it and gets the service answer with an attributed row', async () => {
    const service = await startService();
    const { registry } = wired({ service });
    for (const declaration of declarations) expect(registry.register(OWNER, declaration.id).ok).toBe(true);

    // The scripted harness (synthetic frames, not a real harness): tools/list, then tools/call.
    const harnessList = registry.listed('p1').map(hostToolSpec);
    expect(harnessList.map(tool => tool.name)).toEqual(['memory', 'slow_recall', 'big_dump', 'bare_value', 'broken']);
    expect(harnessList[0]).toMatchObject({ type: 'function', name: 'memory', description: 'Add, search, list and forget memories of this project. (Provided by Memory.)' });
    expect(harnessList.every(tool => !String(tool.name).startsWith('pandacode_'))).toBe(true);

    const rows: Obj[] = [];
    const callTool = async (name: string, args: any) => {
      const outcome = await registry.call('p1', name, args, context);
      if (!outcome.ok) return { isError: true, text: outcome.error.message, code: outcome.error.code };
      rows.push(attributedRow(outcome.served, name));
      const result = modelResult(outcome.served);
      return result.ok ? { isError: false, value: result.value } : { isError: true, text: result.error, code: 'ServiceError' };
    };

    expect(await callTool('memory', { mode: 'add', content: 'pnpm' })).toEqual({ isError: false, value: { added: 1 } });
    expect(await callTool('memory', { mode: 'list' })).toEqual({ isError: false, value: { memories: ['pnpm'] } });
    expect(rows[0]).toEqual({ title: 'memory', owner: OWNER, label: 'Memory served memory.', status: 'completed' });
    // The service saw the input and the task and project of the call.
    const seen = (await service.commands.get('sample.memory/control')!({ args: { op: 'calls' } })) as Obj;
    expect(seen.calls[0]).toMatchObject({ tool: 'memory', input: { mode: 'add', content: 'pnpm' }, call: { taskId: 't1', projectId: 'p1', harness: 'fake-acp' } });

    // Invalid input never reaches the service.
    const before = seen.calls.length;
    expect(await callTool('memory', { mode: 'drop' })).toMatchObject({ isError: true, code: 'InvalidShape' });
    expect(((await service.commands.get('sample.memory/control')!({ args: { op: 'calls' } })) as Obj).calls).toHaveLength(before);
    // An error result of the handler reaches the model as an error result carrying its content.
    expect(await callTool('memory', { mode: 'search', content: 'absent' })).toEqual({ isError: true, text: 'No memory matches.', code: 'ServiceError' });
    expect(await callTool('broken', {})).toEqual({ isError: true, text: 'it broke', code: 'ServiceError' });
    // A handler past its declared timeout, a result past 64 KiB and a bare value each give an error result at once.
    expect(await callTool('slow_recall', {})).toMatchObject({ isError: true, code: 'Timeout' });
    expect(await callTool('big_dump', {})).toMatchObject({ isError: true, code: 'LimitExceeded' });
    expect(await callTool('bare_value', {})).toMatchObject({ isError: true, code: 'InvalidShape' });
    expect(await callTool('pandacode_memory', {})).toMatchObject({ isError: true, code: 'NotFound' });
  });

  test('a stopped service, a disabled package and a missing tools.model grant leave nothing to call', async () => {
    const service = await startService();
    const running = wired({ service });
    running.registry.register(OWNER, 'sample.memory/memory');
    // The service ended: its handlers go with it, and the tool answers at once.
    running.registry.removeOwner(OWNER);
    expect(await running.registry.call('p1', 'memory', { mode: 'list' }, context)).toMatchObject({ ok: false, error: { code: 'HostUnavailable' } });
    // Disable removes the advertised tools (and a call already in flight finds nothing at the next lookup).
    const disabled = wired({ enabled: false, service });
    expect(disabled.registry.listed('p1')).toEqual([]);
    expect(await disabled.registry.call('p1', 'memory', { mode: 'list' }, context)).toMatchObject({ ok: false, error: { code: 'NotFound' } });
    // Without the grant nothing is offered, whatever the manifest declares.
    const denied = wired({ granted: false, service });
    expect(denied.registry.listed('p1')).toEqual([]);
    service.stop();
    expect(service.handlers.size).toBe(0);
  });

  test('the provider core tools.list shares the same inventory', () => {
    const { registry, wiring } = wired({});
    const core = [{ type: 'function', name: 'pandacode_preview_file', description: 'Open a preview.', inputSchema: { type: 'object' } }];
    const listed = coreToolsList(registry, wiring, core, new Set(['pandacode_preview_file']), 'p1', { owner: OWNER, version: '1.0.0' });
    expect(listed.map(tool => tool.name)).toEqual(['pandacode_preview_file', 'memory', 'slow_recall', 'big_dump', 'bare_value', 'broken']);
    expect(listed[0]).toMatchObject({ owner: null, needsApproval: true });
    expect(listed.find(tool => tool.name === 'broken')).toMatchObject({ owner: OWNER, needsApproval: false });
    const withoutGrant = wired({ granted: false });
    expect(coreToolsList(withoutGrant.registry, withoutGrant.wiring, core, new Set(), 'p1', { owner: OWNER, version: '1.0.0' }).map(tool => tool.name)).toEqual(['pandacode_preview_file']);
  });
});
