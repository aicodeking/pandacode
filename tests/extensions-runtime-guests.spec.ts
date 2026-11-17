import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { GuestsModel, KEPT_CAPTURES, MAX_TEXT, PERMISSION, actions, checkInput, readRequest, reason, splitId, type Capabilities, type Checks, type Guest } from '../src/extensions/runtime-guests';

// Preview column of R0410 (virtual machine, simulator and browser guests). The groups run the deterministic model in
// src/extensions/runtime-guests.ts, which mirrors src-tauri/src/extensions/runtime_guests.rs (whose own unit tests are
// `runtime_guests::tests`) over fake guest adapters that record each operation and the capture destination. Driving a real
// VM, simulator or browser guest through the broker is a native/installed qualification and is reported in its own column:
// this file claims only the preview and model column, and no real guest is started.
//
// Refusal-test reconciliation (Q019, Q093): the rows that refuse `frame`, `input`, `credentials`, `screen` and `clipboard` in a
// contributed VM, simulator or browser COMPONENT payload (contracts.rs vm/simulator component tests, extensions-vm,
// -simulator and -browser tests) stay as they are. A contributed component is declarative display data a panel draws; it is
// the wrong carrier for a guest's pixels and input, which would also cross the webview. What this slice delivers is a
// different path: `panda.guests.*` in a service under the named permission `guests.control`, which the model below proves
// granted, revoked and stale. The retained refusals are asserted here with their non-security reason; none is removed.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-guests/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-guests/main.cjs');
const ALL: Capabilities = { vm: true, simulator: true, browser: true };
const yes: Checks = { granted: () => true };
const code = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? 'ok' : reply.error!.code);
const guest = (kind: Guest['kind'], name: string, interactive = true): Guest => ({ kind, name, label: name, state: interactive ? 'running' : 'stopped', interactive });

function model(caps: Capabilities = ALL) {
  const host = new GuestsModel(caps);
  host.add(guest('vm', 'dev')); host.add(guest('vm', 'idle', false)); host.add(guest('simulator', 'UDID-1')); host.add(guest('browser', 'page'));
  return host;
}

test('extensions runtime guests: the fixture package declares the permission and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['guests.list', 'guests.capture', 'guests.input', 'guests.control', 'script', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package has no call that deletes a guest and never touches a credential.
  expect(fixtureSource).not.toMatch(/delete|credentials/i);
  expect(actions('vm')).not.toContain('delete');
});

test('extensions runtime guests: list enumerates the supported kinds and says why a kind is missing', () => {
  const host = model({ vm: false, simulator: true, browser: true });
  const answer = host.call(yes, { op: 'list' });
  expect(answer).toEqual({
    ok: true,
    value: {
      schemaVersion: 1,
      kinds: [{ kind: 'vm', supported: false, reason: reason('vm') }, { kind: 'simulator', supported: true }, { kind: 'browser', supported: true }],
      guests: [{ id: 'simulator:UDID-1', kind: 'simulator', name: 'UDID-1', state: 'running', interactive: true }, { id: 'browser:page', kind: 'browser', name: 'page', state: 'running', interactive: true }],
    },
  });
});

test('extensions runtime guests: a scripted capture lands in the package data directory and the reply never carries image bytes', () => {
  const host = model();
  const reply = host.call(yes, { op: 'capture', id: 'simulator:UDID-1' });
  expect(reply.ok).toBe(true);
  const value = (reply as { value: Record<string, unknown> }).value;
  expect(String(value.path).startsWith(`${host.dataDir}/guests/`)).toBe(true);
  expect(host.files.has(String(value.path))).toBe(true);
  // A frame does not fit a channel message: the answer is small whatever the image, and holds a path, not data.
  expect(JSON.stringify(reply).length).toBeLessThan(512);
  expect(value).not.toHaveProperty('data');
  expect(value).toMatchObject({ schemaVersion: 1, id: 'simulator:UDID-1', kind: 'simulator', mime: 'image/png', bytes: host.files.get(String(value.path))!.length });
  // Scripted input and control reach the guest once, in order, each recorded.
  expect(host.call(yes, { op: 'input', id: 'vm:dev', input: { action: 'click', x: 3, y: 4 } }).ok).toBe(true);
  expect(host.call(yes, { op: 'input', id: 'browser:page', input: { action: 'read' } }).ok).toBe(true);
  expect(host.call(yes, { op: 'control', id: 'vm:idle', action: 'start' })).toEqual({ ok: true, value: null });
  expect(host.call(yes, { op: 'control', id: 'simulator:UDID-1', action: 'dark' }).ok).toBe(true);
  expect(host.log).toEqual(['capture:simulator:UDID-1', 'input:vm:dev:{"action":"click","x":3,"y":4}', 'input:browser:page:{"action":"read"}', 'control:vm:idle:start', 'control:simulator:UDID-1:dark']);
  // The VM that was not interactive is now, and a capture of it lands in its own jpg.
  const vm = host.call(yes, { op: 'capture', id: 'vm:idle' }) as { value: { path: string; mime: string } };
  expect([vm.value.mime, vm.value.path.endsWith('.jpg')]).toEqual(['image/jpeg', true]);
});

test('extensions runtime guests: an unsupported kind is UnsupportedCapability and an unknown id is NotFound', () => {
  const host = model({ vm: false, simulator: true, browser: true });
  for (const raw of [{ op: 'capture', id: 'vm:dev' }, { op: 'control', id: 'vm:dev', action: 'start' }, { op: 'input', id: 'vm:dev', input: { action: 'click' } }, { op: 'capture', id: 'docker:x' }]) expect(code(host.call(yes, raw)), JSON.stringify(raw)).toBe('UnsupportedCapability');
  expect(code(model().call(yes, { op: 'capture', id: 'vm:missing' }))).toBe('NotFound');
  expect(code(model().call(yes, { op: 'control', id: 'simulator:nope', action: 'boot' }))).toBe('NotFound');
  expect(splitId('novalidid')).toMatchObject({ code: 'InvalidShape' });
  expect(splitId('browser:page')).toEqual({ kind: 'browser', name: 'page' });
  // Nothing reached a guest.
  expect(host.log).toEqual([]);
});

test('extensions runtime guests: calls and inputs are read strictly and a guest that is not interactive is Conflict', () => {
  const host = model();
  for (const raw of ['x', {}, { op: 'delete', id: 'vm:dev' }, { op: 'list', id: 'vm:dev' }, { op: 'capture' }, { op: 'capture', id: '' }, { op: 'input', id: 'vm:dev' }, { op: 'input', id: 'vm:dev', input: 'tap' }, { op: 'control', id: 'vm:dev' }]) expect(code(host.call(yes, raw)), JSON.stringify(raw)).toBe('InvalidShape');
  expect(readRequest({ op: 'input', id: 'vm:dev', input: { action: 'type', text: 'x'.repeat(MAX_TEXT + 1) } })).toMatchObject({ code: 'LimitExceeded' });
  // An input of another kind's shape, an unknown action and deleting a VM are refused before the guest hears of it.
  expect(checkInput('vm', { kind: 'tap' })).toMatchObject({ code: 'InvalidShape' });
  expect(checkInput('simulator', { kind: 'tap', x: 1, y: 2 })).toBeNull();
  for (const raw of [{ op: 'input', id: 'simulator:UDID-1', input: { action: 'click' } }, { op: 'control', id: 'vm:dev', action: 'delete' }, { op: 'control', id: 'browser:page', action: 'start' }]) expect(code(host.call(yes, raw)), JSON.stringify(raw)).toBe('InvalidShape');
  expect(code(host.call(yes, { op: 'capture', id: 'vm:idle' }))).toBe('Conflict');
  expect(code(host.call(yes, { op: 'input', id: 'vm:idle', input: { action: 'click' } }))).toBe('Conflict');
  expect(host.log).toEqual([]);
});

test('extensions runtime guests: a package keeps only its newest captures', () => {
  const host = model();
  const paths: string[] = [];
  for (let index = 0; index < KEPT_CAPTURES + 5; index += 1) paths.push(((host.call(yes, { op: 'capture', id: 'browser:page' }) as { value: { path: string } }).value.path));
  expect(host.files.size).toBe(KEPT_CAPTURES);
  expect(host.files.has(paths[0])).toBe(false);
  expect(host.files.has(paths.at(-1)!)).toBe(true);
});

test('extensions runtime guests: revoke stops package control and safe mode restores built-in operation without touching the guests', () => {
  const host = model();
  let held = true;
  const live: Checks = { granted: () => held };
  expect(host.call(live, { op: 'control', id: 'vm:dev', action: 'suspend' }).ok).toBe(true);
  expect(host.guests.get('vm:dev')!.state).toBe('stopped');
  held = false;
  // A revoked package learns nothing and changes nothing; the permission is named in the refusal.
  const refused = host.call(live, { op: 'list' });
  expect(refused).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  for (const raw of [{ op: 'control', id: 'simulator:UDID-1', action: 'shutdown' }, { op: 'capture', id: 'browser:page' }, { op: 'input', id: 'simulator:UDID-1', input: { kind: 'tap' } }]) expect(code(host.call(live, raw))).toBe('PermissionDenied');
  expect(host.log).toEqual(['control:vm:dev:suspend']);
  // The guests are as they were: the revoke stopped no unrelated guest work.
  expect([host.guests.get('simulator:UDID-1')!.state, host.guests.get('browser:page')!.state]).toEqual(['running', 'running']);
  // Safe mode is the same refusal for the package, while the built-in panel still starts, stops and drives every guest.
  expect(host.builtin('vm:dev', 'start')).toBe(true);
  expect(host.guests.get('vm:dev')).toMatchObject({ state: 'running', interactive: true });
  expect(host.builtin('vm:dev', 'delete')).toBe(false);
  // A revoke that lands after the guest was found and before it is touched changes nothing.
  held = true;
  expect(code(host.call(live, { op: 'control', id: 'simulator:UDID-1', action: 'shutdown' }, () => { held = false; }))).toBe('PermissionDenied');
  expect(host.guests.get('simulator:UDID-1')!.state).toBe('running');
  // A capture revoked while it was taken leaves no file behind.
  held = true;
  const before = host.files.size;
  let calls = 0;
  const flips: Checks = { granted: () => ++calls < 3 };
  expect(code(host.call(flips, { op: 'capture', id: 'browser:page' }))).toBe('PermissionDenied');
  expect(host.files.size).toBe(before);
});

test('extensions runtime guests: the contract, the doc and the registrations agree', () => {
  const doc = read('docs/extensions/runtime-guests.md');
  for (const word of ['guests.control', 'UnsupportedCapability', 'NotFound', 'capture', 'data directory', 'safe mode', 'Q019', 'Q093']) expect(doc, word).toContain(word);
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-guests.spec.ts');
});
