import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { createSpeedPreview, launchMeta, selection, spareKey, validatedTier, IDLE_SECONDS, LIMIT, type WarmContext } from '../src/extensions/runtime-provider-speed';
// Preview column of R0807 (speed tiers and warm-spare opt-in of declared package harnesses). The browser preview starts no
// process: these check the webview twin (src/extensions/runtime-provider-speed.ts) of the native rules against the fixture
// manifest, and run the canonical Node fake agent (tests/fixtures/extensions/backends/fake-agent.mjs) over real stdio to
// prove the spare shape (initialize first, session/new later) and that the selected tier arrives in `_meta`. The installed
// package launching that agent through the native path is `runtime_provider_speed::tests::installed`.
const fixture = new URL('./fixtures/extensions/runtime-provider-speed/', import.meta.url);
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('extension.json', fixture), 'utf8'));
const OWNER = 'sample.speed-agent';
const PROVIDER = 'sample.speed-agent/fake';
const provider = manifest.contributes.providers[0];
const resolved = { program: 'node', arguments: ['agent.mjs'], env: {} };
const context = (over: Partial<WarmContext> = {}): WarmContext => ({ enabled: true, trusted: true, declared: true, ready: true, digest: 'd1', key: spareKey(PROVIDER, 'd1', resolved, '/work'), ...over });
const packages = (overrides: (value: any) => void = () => {}) => { const copy = structuredClone(manifest); overrides(copy); return validateContract('packages', [copy]); };

test('provider speed: a declared harness publishes tiers per model and declares warm spares explicitly', () => {
  const checked = packages();
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  expect(provider.models[0].speedTiers.map((tier: any) => tier.id)).toEqual(['fast', 'ultrafast']);
  expect(provider.models[1].speedTiers).toBeUndefined();
  expect(provider.launch.warmSpare).toBe(true);
  expect(packages(value => { delete value.contributes.providers[0].launch.warmSpare; }).ok, 'the declaration is optional, default off').toBe(true);
  expect(packages(value => { value.contributes.providers[0].launch.warmSpare = 'yes'; }).ok).toBe(false);
  expect(packages(value => { value.contributes.providers[0].launch.warmSparse = true; }).ok).toBe(false);
  expect(packages(value => { value.contributes.providers[0].models[0].speedTiers[0].id = 'Not Valid'; }).ok).toBe(false);
});

test('provider speed: the selected tier reaches the launch only while the model lists it; a model switch drops a stale one', () => {
  const models = provider.models;
  expect(validatedTier(models, 'fixture-large', 'fast')).toBe('fast');
  expect(validatedTier(models, 'fixture-large', null)).toBeNull();
  expect(() => validatedTier(models, 'fixture-small', 'fast')).toThrow('Choose a valid speed.');
  expect(() => validatedTier(models, 'fixture-large', 'warp')).toThrow('Choose a valid speed.');
  const kept = selection('fixture-large', 'high', 'ultrafast', models);
  expect(kept).toEqual({ model: 'fixture-large', effort: 'high', tier: 'ultrafast', droppedTier: null });
  expect(launchMeta(OWNER, kept)).toEqual({ extension: OWNER, model: 'fixture-large', effort: 'high', speedTier: 'ultrafast' });
  const switched = selection('fixture-small', null, 'ultrafast', models);
  expect(switched).toMatchObject({ tier: null, droppedTier: 'ultrafast' });
  expect(selection('gone', null, 'fast', models).tier).toBeNull();
});

test('provider speed: demand-only default, opt-in, model switch, failure, restart, opt-out and revoke with spawn counters', () => {
  const preview = createSpeedPreview();
  // Default: a declaration alone starts nothing, whatever is picked or typed.
  expect(preview.participates(PROVIDER)).toBe(false);
  expect(preview.prewarm(PROVIDER, 't1', context())).toBe(false);
  expect(preview.counters(OWNER).spawns).toBe(0);
  // Opting in starts nothing by itself; prewarm starts exactly one process, repeats and switches keep it.
  preview.setOptIn(OWNER, 'd1');
  expect(preview.counters(OWNER).spawns).toBe(0);
  expect(preview.prewarm(PROVIDER, 't1', context())).toBe(true);
  expect(preview.prewarm(PROVIDER, 't1', context())).toBe(true);
  expect(preview.counters(OWNER)).toMatchObject({ spawns: 1, warmStarted: 1 });
  // A model or tier switch does not change the key (they travel in session/new): the spare is kept.
  expect(spareKey(PROVIDER, 'd1', resolved, '/work')).toBe(context().key);
  // The send adopts it: no second process.
  expect(preview.take('t1', OWNER, context().key)).toBe(true);
  expect(preview.counters(OWNER)).toMatchObject({ spawns: 1, warmAdopted: 1 });
  expect(preview.present('t1')).toBe(false);
  // Failure: an exited spare is discarded, the send starts cold, the next prewarm restarts it.
  preview.prewarm(PROVIDER, 't2', context());
  expect(preview.take('t2', OWNER, context().key, false)).toBe(false);
  preview.coldStart(OWNER);
  expect(preview.counters(OWNER)).toMatchObject({ spawns: 3, warmDiscarded: 1, warmAdopted: 1 });
  expect(preview.prewarm(PROVIDER, 't2', context())).toBe(true);
  expect(preview.counters(OWNER).warmStarted).toBe(3);
  // Another folder is another launch: the spare is discarded.
  expect(preview.take('t2', OWNER, spareKey(PROVIDER, 'd1', resolved, '/elsewhere'))).toBe(false);
  // Disabled, untrusted, not declared and not ready never start; a stale digest revokes the opt-in.
  for (const bad of [{ enabled: false }, { trusted: false }, { declared: false }, { ready: false }, { startAhead: false }]) {
    const before = preview.counters(OWNER).spawns;
    expect(preview.prewarm(PROVIDER, 't3', context(bad)), JSON.stringify(bad)).toBe(false);
    expect(preview.counters(OWNER).spawns).toBe(before);
  }
  expect(preview.prewarm(PROVIDER, 't3', context({ digest: 'd2', key: 'k' }))).toBe(false);
  expect(preview.participates(PROVIDER), 'an updated executable revokes the opt-in').toBe(false);
  // Opt-out ends the spares; disable (discardOwner) ends them too.
  preview.setOptIn(OWNER, 'd1');
  preview.prewarm(PROVIDER, 't4', context());
  preview.setOptIn(OWNER, null);
  expect(preview.present('t4')).toBe(false);
  preview.setOptIn(OWNER, 'd1');
  preview.prewarm(PROVIDER, 't5', context());
  preview.discardOwner(OWNER);
  expect(preview.present('t5')).toBe(false);
  preview.prewarm(PROVIDER, 't5', context());
  preview.discardAll();
  expect(preview.present('t5')).toBe(false);
  // The limit across tasks and the idle bound.
  for (const session of ['a', 'b', 'c']) preview.prewarm(PROVIDER, session, context());
  expect([preview.present('a'), preview.present('b'), preview.present('c')]).toEqual([false, true, true]);
  expect(LIMIT).toBe(2);
  expect(IDLE_SECONDS).toBe(600);
});

test('provider speed: an old spare is never adopted and every record is attributed without a secret-shaped field', () => {
  let now = 0;
  const preview = createSpeedPreview(() => now);
  preview.setOptIn(OWNER, 'd1');
  preview.prewarm(PROVIDER, 'old', context());
  now = IDLE_SECONDS * 1000;
  expect(preview.take('old', OWNER, context().key)).toBe(false);
  preview.recordLaunch(OWNER, PROVIDER, 'old', selection('fixture-small', null, 'fast', provider.models), false);
  preview.recordPick(PROVIDER, 'old', 'fixture-large', 'fast');
  const events = preview.events();
  expect(events.every(event => event.extension === OWNER && typeof event.seq === 'number')).toBe(true);
  expect(events.map(event => event.what)).toEqual(expect.arrayContaining(['optIn', 'spareStarted', 'spareDiscarded', 'tierDropped', 'launch', 'tierSelected']));
  const text = JSON.stringify(events);
  expect(text).not.toMatch(/token|secret|credential|password/i);
  const projection = preview.projection([{ manifest: manifest, enabled: true, executable: { digest: 'd1', trusted: true } }]);
  expect(projection.packages[0]).toMatchObject({ id: OWNER, optedIn: true, trusted: true, enabled: true });
  expect(JSON.stringify(projection)).not.toContain('"digest"');
  expect(projection.packages[0].providers).toEqual([PROVIDER]);
});

test('provider speed: the canonical fake agent initializes first as a spare and later receives the selected tier in session/new _meta', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pandacode-speed-'));
  const log = join(directory, 'frames.log');
  const child = spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { ...process.env, FAKE_AGENT_LOG: log } });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  try {
    const frames = createInterface({ input: child.stdout });
    const waiting = new Map<number, (frame: any) => void>();
    frames.on('line', line => { const frame = JSON.parse(line); waiting.get(frame.id)?.(frame); });
    const call = (id: number, method: string, params: unknown) => new Promise<any>(resolve => { waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    // The spare: initialize and nothing else, then it waits.
    expect((await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })).result.protocolVersion).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 200));
    const picked = selection('fixture-large', 'high', 'ultrafast', provider.models);
    const session = (await call(2, 'session/new', { cwd: '.', mcpServers: [], _meta: { pandacode: launchMeta(OWNER, picked) } })).result.sessionId;
    expect((await call(3, 'session/prompt', { sessionId: session, prompt: [{ type: 'text', text: 'hello speed' }] })).result.stopReason).toBe('end_turn');
    const recorded = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(recorded.map(frame => frame.method).filter(Boolean).slice(0, 3)).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(recorded.find(frame => frame.method === 'session/new').params._meta.pandacode).toEqual({ extension: OWNER, model: 'fixture-large', effort: 'high', speedTier: 'ultrafast' });
  } finally {
    child.stdin.end();
    expect(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))])).toBe(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
