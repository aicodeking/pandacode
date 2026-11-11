/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
// demo-host first, as the app loads it: demo handlers use its helpers inside their bodies.
import '../src/demo-host.ts';
import type { Harness } from '../src/connect/api/settings.ts';
import { harnessDetail, readinessLabel, routingNote, sortHarnesses, tokenSaverNote } from '../src/ui/hub/settings-labels.ts';
import { handlers } from '../src/demo/settings.ts';
import { parseHello } from '../src/connect/api/hello.ts';
import { hubSections } from '../src/ui/hub/entries.ts';

const harness = (patch: Partial<Harness>): Harness => ({ id: 'codex', name: 'Codex', installed: true, executable: 'codex', version: '1.0.0', models: 3, status: 'installed', update: null, ...patch });

test('readiness maps to a dot tone and words', () => {
  assert.deepEqual(readinessLabel({ status: 'ready' }), { tone: 'success', text: 'Ready' });
  assert.deepEqual(readinessLabel({ status: 'needsKey' }), { tone: 'warning', text: 'Needs an API key' });
  assert.deepEqual(readinessLabel({ status: 'signedOut' }), { tone: 'warning', text: 'Not signed in' });
  assert.deepEqual(readinessLabel({ status: 'missing' }), { tone: null, text: 'Not installed' });
  assert.deepEqual(readinessLabel({ status: 'installed' }), { tone: 'info', text: 'Installed' });
});

test('harness detail names version, executable, models and an update to run on the computer', () => {
  assert.equal(harnessDetail(harness({})), '1.0.0 · codex · 3 models');
  assert.equal(harnessDetail(harness({ models: 1 })), '1.0.0 · codex · 1 model');
  assert.equal(harnessDetail(harness({ update: { status: 'available', latest: '1.2.0', canUpdate: true } })), '1.0.0 · codex · 3 models · Update to 1.2.0 on the computer');
  assert.equal(harnessDetail(harness({ installed: false, status: 'missing' })), 'Install it on the computer to use it');
  assert.equal(harnessDetail(harness({ version: '', executable: null, models: 0 })), '');
});

test('ready harnesses sort first, missing ones last, then by name', () => {
  const list = [harness({ id: 'z', name: 'Zed', status: 'missing', installed: false }), harness({ id: 'b', name: 'Beta' }), harness({ id: 'a', name: 'Alpha', status: 'ready' }), harness({ id: 'c', name: 'Able' })];
  assert.deepEqual(sortHarnesses(list).map(h => h.id), ['a', 'c', 'b', 'z']);
  assert.equal(list[0].id, 'z', 'the input is not reordered');
});

test('routing and token saver notes follow the computer state', () => {
  assert.match(routingNote({ on: false, mode: 'balanced', profiler: 'ready', failed: false }), /as set up/);
  assert.match(routingNote({ on: true, mode: 'balanced', profiler: 'missing', failed: false }), /downloads/);
  assert.match(routingNote({ on: true, mode: 'balanced', profiler: 'ready', failed: true }), /couldn’t prepare/);
  assert.match(routingNote({ on: true, mode: 'balanced', profiler: 'ready', failed: false }), /most likely/);
  assert.match(tokenSaverNote({ rtk: true, rtkVersion: '0.37.1' }), /^RTK 0\.37\.1 is installed/);
  assert.match(tokenSaverNote({ rtk: false, rtkVersion: '' }), /isn’t installed/);
});

test('hub rows for settings and moodboards show only when served', () => {
  const keys = (methods: string[]) => hubSections(parseHello({ protocol: 2, appVersion: '1', methods, features: [] })!).flatMap(s => s.entries.map(e => e.key));
  assert.deepEqual(keys(['tasks.list']), ['tasks']);
  assert.ok(keys(['settings.providers', 'moodboards.list']).includes('settings'));
  assert.ok(keys(['settings.providers', 'moodboards.list']).includes('moodboards'));
});

test('demo settings answer like a host and carry nothing secret', async () => {
  const ctx = { host: { now: () => 1_700_000_000_000 } } as any;
  const { providers } = await handlers['settings.providers'](ctx, {}) as { providers: Harness[] };
  for (const h of providers) assert.ok(!h.executable?.includes('/'), h.id);
  assert.equal((await handlers['settings.setRouting'](ctx, { on: true }) as { on: boolean }).on, true);
  assert.equal((await handlers['settings.routing'](ctx, {}) as { on: boolean }).on, true);
  await handlers['settings.setRouting'](ctx, { on: false });
  assert.throws(() => handlers['settings.setRouting'](ctx, { on: 'yes' }), /Missing on/);
  const { boards } = await handlers['moodboards.list'](ctx, { projectId: 'p' }) as { boards: { id: string; images: { id: string }[] }[] };
  const page = await handlers['moodboards.image'](ctx, { projectId: 'p', boardId: boards[0].id, imageId: boards[0].images[0].id }) as { mime: string; done: boolean };
  assert.equal(page.mime, 'image/svg+xml');
  assert.ok(page.done);
  assert.throws(() => handlers['moodboards.image'](ctx, { imageId: 'nope' }), /unavailable/);
});
