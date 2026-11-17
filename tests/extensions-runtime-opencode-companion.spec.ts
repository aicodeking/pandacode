import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { opencodeInline, OPENCODE_V2_SOURCE, v1Hooks, v2Hooks } from '../src/extensions/runtime-opencode-companion';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-opencode-companion/profiles.json', import.meta.url), 'utf8'));
test('extensions opencode companion: generation loaders preserve ACP environment and reject incompatible entries', () => {
  expect(fixture.provenance).toBe('synthetic'); expect(fixture.liveCapture).toBe(false);
  for (const row of fixture.profiles) {
    const installed = { harness: 'opencode', version: row.version, apis: [row.api] };
    const env = opencodeInline(installed, row.url, false, row.previous);
    // ACP children inherit this process-only inline document; no configuration file is written.
    const acpChildEnv = { ...env }; const config = JSON.parse(acpChildEnv.OPENCODE_CONFIG_CONTENT!);
    expect(config.model).toBe('preserved'); expect(config[row.key]).toHaveLength(2);
    expect(() => opencodeInline(installed, row.url, true)).toThrow('UnsupportedCapability');
  }
  expect(() => opencodeInline({ harness: 'opencode', version: OPENCODE_V2_SOURCE, apis: ['opencode.plugin.v2'] }, 'file:///run/companion.mjs', false)).toThrow('directory');
  expect(() => opencodeInline({ harness: 'opencode', version: 'future', apis: ['opencode.plugin.v2'] }, 'file:///run/companion/', false)).toThrow('UnsupportedCapability');
});
test('extensions opencode companion: V1 identity mutation and V2 permission powers are distinct', async () => {
  const args = { removed: true }; const output = { args };
  const v1 = v1Hooks(async () => ({ decision: 'rewrite', input: { new: 'value' } }));
  await v1['tool.execute.before']({ tool: 'bash' }, output);
  expect(output.args).toBe(args); expect(args).toEqual({ new: 'value' });
  await expect(v1Hooks(async () => ({ decision: 'deny', reason: 'guard' }))['tool.execute.before']({}, output)).rejects.toThrow('guard');
  await v1Hooks(async () => ({ approved: false }))['tool.execute.before']({}, output);
  await v1Hooks(async () => { throw new Error('unavailable'); })['tool.execute.before']({}, output);
  const v2 = v2Hooks(async () => ({ decision: 'approve' }));
  const denied = { effect: 'deny' }; await v2.permission(denied); expect(denied.effect).toBe('deny');
  const asked = { effect: 'ask' }; await v2.permission(asked); expect(asked.effect).toBe('allow');
});
function bundle(name: string) {
  const source = readFileSync('src-tauri/src/extensions/runtime_opencode_companion.rs', 'utf8');
  return source.match(new RegExp(`pub const ${name}: &str = r#"([\\s\\S]*?)"#;`))![1]!;
}
test('extensions opencode companion: shipped V1 and V2 entries apply real mutable APIs and withdraw late answers', async () => {
  const previous = process.env.PANDACODE_COMPANION_TRANSPORT; const originalFetch = globalThis.fetch;
  let answer: Record<string, unknown> = {}; const calls: Record<string, unknown>[] = [];
  process.env.PANDACODE_COMPANION_TRANSPORT = JSON.stringify({ protocol: 1, harness: 'opencode', lease: { taskId: 'task', runId: 'run', leaseId: 'fixture' }, endpoint: 'http://127.0.0.1:1/companion', credential: 'fixture-canary' });
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json(answer); };
  const load = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  try {
    const v1 = (await load(bundle('CORE') + bundle('V1_ENTRY'))).default;
    const hooks = await v1(); const args = { old: true };
    answer = { decision: 'rewrite', input: { changed: true } };
    expect(await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'session', callID: 'call' }, { args })).toBeUndefined();
    expect(args).toEqual({ changed: true }); expect(calls[0]!.harness).toBe('opencode');
    answer = { decision: 'deny', reason: 'guard' };
    await expect(hooks['tool.execute.before']({}, { args })).rejects.toThrow('guard');
    await hooks.dispose(); const count = calls.length;
    answer = { decision: 'rewrite', input: { late: true } }; await hooks['tool.execute.before']({}, { args });
    expect(calls.length).toBe(count); expect(args).toEqual({ changed: true });
    const definition = (await load(bundle('CORE') + bundle('V2_ENTRY').replace("import { Plugin } from '@opencode/plugin';", 'const Plugin={define:value=>value};'))).default;
    const tool = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
    const permission = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
    const dispose = await definition.setup({ tool: { hook(name: string, fn: (event: Record<string, unknown>) => Promise<void>) { tool.set(name, fn); } }, permission: { hook(name: string, fn: (event: Record<string, unknown>) => Promise<void>) { permission.set(name, fn); } } });
    const event = { input: { old: true } }; answer = { decision: 'rewrite', input: { replacement: true } };
    await tool.get('execute.before')!(event); expect(event.input).toEqual({ replacement: true });
    const failed = { status: 'error', error: 'failed' }; answer = { output: { output: 'must not replace failure' } };
    await tool.get('execute.after')!(failed); expect(failed).not.toHaveProperty('result');
    const effect = { effect: 'ask' }; answer = { decision: 'approve' }; await permission.get('evaluate')!(effect); expect(effect.effect).toBe('allow');
    dispose();
  } finally { globalThis.fetch = originalFetch; if (previous === undefined) delete process.env.PANDACODE_COMPANION_TRANSPORT; else process.env.PANDACODE_COMPANION_TRANSPORT = previous; }
});
