import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { KILO_SOURCE, kiloInline, kiloProfile, kiloHooks } from '../src/extensions/runtime-kilo-companion';
const installed = { harness: 'kilo', version: KILO_SOURCE, apis: ['kilo.plugin.v1'] };
test('extensions kilo companion: independent profile, child inline config and refusals', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/extensions/runtime-kilo-companion/profile.json', 'utf8'));
  expect(fixture.liveCapture).toBe(false);
  expect(kiloProfile(installed)?.evidence).toBe('sourceFeasible');
  expect(kiloProfile({ ...installed, version: 'unknown' })).toBeNull();
  const previous = JSON.stringify({ model: 'kept', plugin: ['existing'] });
  const env = kiloInline(installed, 'file:///C:/run/companion.mjs', false, previous);
  expect(JSON.parse(env.KILO_CONFIG_CONTENT)).toEqual({ model: 'kept', plugin: ['existing', 'file:///C:/run/companion.mjs'] });
  expect(Object.hasOwn(env, 'OPENCODE_CONFIG_CONTENT')).toBe(false);
  for (const call of [() => kiloInline(installed, 'file:///run/x.mjs', true), () => kiloInline(installed, 'file:///run/x.mjs', false, '{"plugins":[]}'), () => kiloInline(installed, 'file:///run/x.mjs', false, '{}', 'v2'), () => kiloInline({ ...installed, apis: ['opencode.plugin.v1'] }, 'file:///run/x.mjs', false)]) expect(call).toThrow();
  const hooks = kiloHooks(async () => { throw Error('disconnected'); });
  const args = { original: true }; await hooks['tool.execute.before']({}, { args }); expect(args).toEqual({ original: true });
});
test('extensions kilo companion: shipped V1 loader forwards Kilo identity and disposes', async () => {
  const source = await readFile('src-tauri/src/extensions/runtime_opencode_companion.rs', 'utf8');
  const extract = (name: string) => source.match(new RegExp(`pub const ${name}: &str = r#"([\\s\\S]*?)"#;`))![1];
  const originalFetch = globalThis.fetch; const originalEnv = process.env.PANDACODE_COMPANION_TRANSPORT;
  const seen: Record<string, unknown>[] = []; let answer: Record<string, unknown> = { decision: 'rewrite', input: { updated: true } };
  process.env.PANDACODE_COMPANION_TRANSPORT = JSON.stringify({ protocol: 1, harness: 'kilo', lease: 'fixture-lease', endpoint: 'http://127.0.0.1:1/companion', credential: 'fixture-canary' });
  globalThis.fetch = async (_url, init) => { seen.push(JSON.parse(String(init?.body))); return Response.json(answer); };
  try {
    const entry = await import(`data:text/javascript;base64,${Buffer.from(extract('CORE') + extract('V1_ENTRY')).toString('base64')}#kilo`);
    const hooks = await entry.default(); const args = { old: true }; const output = { args };
    await hooks['tool.execute.before']({ tool: 'shell' }, output);
    expect(output.args).toBe(args); expect(args).toEqual({ updated: true }); expect(seen[0].harness).toBe('kilo');
    answer = { decision: 'deny', reason: 'fixture denial' }; await expect(hooks['tool.execute.before']({}, output)).rejects.toThrow('fixture denial');
    answer = { output: { title: 'updated', output: 'result', metadata: { fixture: true } } }; const result = { title: 'old', output: 'old', metadata: {} };
    await hooks['tool.execute.after']({}, result); expect(result.title).toBe('updated'); expect(result.output).toBe('result');
    await hooks.dispose(); const count = seen.length; await hooks['tool.execute.before']({}, output); expect(seen).toHaveLength(count);
  } finally { globalThis.fetch = originalFetch; if (originalEnv === undefined) delete process.env.PANDACODE_COMPANION_TRANSPORT; else process.env.PANDACODE_COMPANION_TRANSPORT = originalEnv; }
});
