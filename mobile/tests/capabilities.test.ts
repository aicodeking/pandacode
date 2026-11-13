/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { capabilitiesOf, forgetCapabilities, markMissing, refusalMeansStale, setCapabilities, useCapabilities } from '../src/connect/api/capabilities.ts';
import { allows, blockedBy, blockedNote, isLegacyHelloError, legacy, LEGACY_METHODS, needsFullAccessSwitch, parseHello, supports, SWITCH_METHODS, withMissing } from '../src/connect/api/hello.ts';
import { isKnownMethod, METHODS, registerMethods, request } from '../src/connect/rpc.ts';

const hello = { protocol: 2, appVersion: '0.4.0', methods: ['tasks.list', 'host.hello', 'thread.rename', 42, 'x'.repeat(65)], limits: { maxText: 102400, pageBudget: -1, maxBatch: 8, bad: 'no' }, features: ['packedFrames', 'threads'] };

test('host.hello decodes methods, limits and features and drops malformed entries', () => {
  const caps = parseHello(hello)!;
  assert.equal(caps.kind, 'hello');
  assert.equal(caps.protocol, 2);
  assert.equal(caps.appVersion, '0.4.0');
  assert.deepEqual([...caps.methods], ['tasks.list', 'host.hello', 'thread.rename']);
  assert.deepEqual(caps.limits, { maxText: 102400, maxBatch: 8 });
  assert.deepEqual([...caps.features], ['packedFrames', 'threads']);
  for (const bad of [null, 'hi', {}, { protocol: 1, methods: [] }, { protocol: 2.5, methods: [] }, { protocol: 2 }]) assert.equal(parseHello(bad), null, JSON.stringify(bad));
});

test('supports: known from hello, core-only for legacy hosts, unknown before either', () => {
  const caps = parseHello(hello)!;
  assert.equal(supports(caps, 'thread.rename'), true);
  assert.equal(supports(caps, 'git.push'), false);
  assert.equal(supports(undefined, 'git.push'), undefined);
  assert.equal(supports(legacy(), 'task.send'), true);
  assert.equal(supports(legacy(), 'host.hello'), false);
  assert.equal(supports(legacy(), 'thread.rename'), false);
  assert.equal(supports(withMissing(legacy(), 'task.team'), 'task.team'), false);
  assert.equal(supports(withMissing(caps, 'thread.rename'), 'thread.rename'), false);
  assert.ok(!LEGACY_METHODS.has('host.hello'));
});

test('older hosts are recognised by their host.hello refusal', () => {
  assert.ok(isLegacyHelloError('Unknown method.'));
  assert.ok(isLegacyHelloError('This device can only view tasks on Mac.'));
  assert.ok(isLegacyHelloError('This device is not allowed to do that on Mac. Ask for full access.'));
  assert.ok(!isLegacyHelloError('That computer is offline.'));
  assert.ok(!isLegacyHelloError('Waiting for approval on Mac.'));
  assert.ok(!isLegacyHelloError('Mac has blocked this device.'));
});

test('the capability store keeps hosts apart and records refused methods', () => {
  forgetCapabilities();
  setCapabilities('mac', parseHello(hello)!);
  markMissing('mac', 'thread.rename');
  markMissing('old', 'thread.rename');
  assert.equal(supports(capabilitiesOf('mac'), 'thread.rename'), false);
  assert.equal(supports(capabilitiesOf('mac'), 'tasks.list'), true);
  assert.equal(capabilitiesOf('old')?.kind, 'legacy', 'a refusal before any hello marks the host legacy');
  forgetCapabilities('mac');
  assert.equal(capabilitiesOf('mac'), undefined);
  assert.ok(capabilitiesOf('old'));
  forgetCapabilities();
  assert.deepEqual(useCapabilities.getState(), {});
});

test('rpc METHODS lists every built-in host method, and feature methods are registered', () => {
  const host = readFileSync(new URL('../../src-tauri/src/remote/host.rs', import.meta.url), 'utf8');
  const list = host.match(/pub\(crate\) const METHODS: \[&str; \d+\] = \[([^\]]*)\]/)![1];
  const builtIn = [...list.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.ok(builtIn.length > 30);
  assert.deepEqual([...METHODS].filter(m => m !== 'host.hello').sort(), [...builtIn].sort());
  assert.throws(() => request('thread.testRename', {}), /Unknown remote method/);
  assert.deepEqual(registerMethods(['thread.testRename'] as const), ['thread.testRename']);
  assert.ok(isKnownMethod('thread.testRename'));
  assert.equal(request('thread.testRename', { sessionId: 's' }).method, 'thread.testRename');
  for (const bad of ['Thread.rename', 'rename', 'a..b', 'a.b c']) assert.throws(() => registerMethods([bad]), /Invalid method name/, bad);
});

test('the SWITCH_METHODS fallback matches the host list in methods/mod.rs', () => {
  const source = readFileSync(new URL('../../src-tauri/src/remote/methods/mod.rs', import.meta.url), 'utf8');
  const list = source.match(/pub\(crate\) const SWITCH_METHODS: \[&str; (\d+)\] =\s*\[([^\]]*)\]/)!;
  const host = [...list[2].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.equal(host.length, Number(list[1]));
  assert.deepEqual([...SWITCH_METHODS].sort(), [...host].sort());
});

const granted = (access: unknown, extra: Record<string, unknown> = {}) => parseHello({
  protocol: 2, appVersion: '1', methods: ['tasks.list', 'task.send', 'task.start', 'terminal.open', 'files.write'], features: [], access,
  methodAccess: { 'tasks.list': 'view', 'task.send': 'control', 'task.start': 'full', 'terminal.open': 'full', 'files.write': 'full', 'bad name': 'full', 'x.y': 'root' },
  fullAccessSwitch: ['terminal.open', 'files.write'], ...extra,
})!;

test('host.hello decodes this phone\'s grant, each method\'s grant and the Full access switch', () => {
  const caps = granted('control');
  assert.ok(caps.kind === 'hello');
  assert.equal(caps.access, 'control');
  assert.deepEqual([...caps.methodAccess], [['tasks.list', 'view'], ['task.send', 'control'], ['task.start', 'full'], ['terminal.open', 'full'], ['files.write', 'full']]);
  assert.deepEqual([...caps.switchMethods], ['terminal.open', 'files.write']);
  assert.equal(caps.remoteFullAccess, false);
  assert.equal(granted('root').access, undefined, 'an unknown grant is ignored');
  const older = parseHello(hello)!;
  assert.ok(older.kind === 'hello');
  assert.equal(older.access, undefined);
  assert.equal(older.methodAccess.size, 0);
  assert.equal(older.switchMethods, SWITCH_METHODS, 'the known gated methods when the host does not list them');
  assert.ok(SWITCH_METHODS.has('runScript.start') && SWITCH_METHODS.has('checks.run') && SWITCH_METHODS.has('terminal.write'));
});

test('allows combines support, the phone\'s grant and the Full access switch', () => {
  const view = granted('view');
  assert.equal(blockedBy(view, 'tasks.list'), null);
  assert.equal(blockedBy(view, 'task.send'), 'access');
  assert.equal(blockedBy(view, 'terminal.open'), 'access', 'the grant comes first');
  assert.equal(blockedBy(view, 'git.push'), 'outdated');
  const control = granted('control');
  assert.ok(allows(control, 'task.send'));
  assert.ok(!allows(control, 'task.start'));
  const full = granted('full');
  assert.ok(allows(full, 'task.start'));
  assert.equal(blockedBy(full, 'terminal.open'), 'switch');
  assert.ok(needsFullAccessSwitch(full, 'files.write'));
  const on = granted('full', { features: ['remoteFullAccess'] });
  assert.ok(allows(on, 'terminal.open') && !needsFullAccessSwitch(on, 'terminal.open'));
  // Unknown stays allowed: no flicker before host.hello, nothing hidden by an older host.
  assert.ok(allows(undefined, 'task.start'));
  assert.ok(allows(parseHello(hello)!, 'tasks.list'));
  assert.ok(allows(legacy(), 'task.start'));
  assert.ok(!allows(withMissing(legacy(), 'task.start'), 'task.start'));
  assert.equal(blockedNote('switch', 'Mac'), 'Turn on Full access for remote tasks on Mac to use this.');
  assert.equal(blockedNote('outdated', 'Mac'), 'Update PandaCode on Mac to use this.');
  assert.match(blockedNote('access', 'Mac', 'view'), /only view tasks on Mac/);
  assert.match(blockedNote('access', 'Mac', 'control'), /Full access on Mac/);
});

test('a computer that goes offline is asked host.hello again (client.ts forgets it)', () => {
  const client = readFileSync(new URL('../src/connect/client.ts', import.meta.url), 'utf8');
  assert.match(client, /if \(!d\.online\) \{ helloed\.delete\(d\.id\); forgetCapabilities\(d\.id\); \}/);
});

test('a switch or grant refusal of a call the cached host.hello allowed means the caps are stale', () => {
  const on = parseHello({ protocol: 2, methods: ['terminal.open', 'thread.rename', 'files.list'], access: 'full', features: ['remoteFullAccess'], methodAccess: { 'thread.rename': 'control', 'files.list': 'view' } })!;
  const off = parseHello({ protocol: 2, methods: ['terminal.open'], access: 'full', features: [] })!;
  const viewer = parseHello({ protocol: 2, methods: ['thread.rename'], access: 'view', methodAccess: { 'thread.rename': 'control' } })!;
  const switchOff = 'Full access is off for remote tasks on Mac.';
  assert.equal(refusalMeansStale(on, 'terminal.open', switchOff), true, 'the switch was turned off on the computer');
  assert.equal(refusalMeansStale(on, 'thread.rename', 'This device can only view tasks on Mac.'), true, 'the grant was narrowed');
  assert.equal(refusalMeansStale(on, 'thread.rename', 'This device is not allowed to do that on Mac. Ask for full access.'), true);
  assert.equal(refusalMeansStale(off, 'terminal.open', switchOff), false, 'the cache already said the switch was off');
  assert.equal(refusalMeansStale(viewer, 'thread.rename', 'This device can only view tasks on Mac.'), false, 'the cache already said view only');
  assert.equal(refusalMeansStale(on, 'thread.rename', 'Thread not found.'), false, 'other errors say nothing about caps');
  assert.equal(refusalMeansStale(legacy(), 'thread.rename', 'This device can only view tasks on Mac.'), false);
  assert.equal(refusalMeansStale(undefined, 'thread.rename', switchOff), false);
});

test('the terminal and file refusals of a switched-off host also mean the caps are stale', () => {
  const on = parseHello({ protocol: 2, methods: ['terminal.open', 'files.write'], access: 'full', features: ['remoteFullAccess'] })!;
  const off = parseHello({ protocol: 2, methods: ['terminal.open', 'files.write'], access: 'full', features: [] })!;
  // terminal.rs require_full_access_to and NEEDS_FULL_ACCESS, word for word.
  const editFiles = 'Turn on Full access for remote tasks on this computer to edit files.';
  const terminal = 'Turn on Full access for remote tasks on this computer to use the terminal.';
  assert.equal(refusalMeansStale(on, 'files.write', editFiles), true);
  assert.equal(refusalMeansStale(on, 'terminal.open', terminal), true);
  assert.equal(refusalMeansStale(off, 'terminal.open', terminal), false, 'the cache already said the switch was off');
  assert.equal(refusalMeansStale(on, 'terminal.open', 'Turn on the terminal.'), false);
});

test('client.ts asks host.hello again on foreground and after a stale refusal', () => {
  const client = readFileSync(new URL('../src/connect/client.ts', import.meta.url), 'utf8');
  assert.match(client, /refusalMeansStale\(capabilitiesOf\(deviceId\), method, message\)/);
  assert.match(client, /void subscribeAll\(\);\n\s*rediscoverAll\(\);/);
});
