import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { admitDialogAccessory, dialogContext, isEligibleDialog, MAX_DIALOG_BODY_EXTRAS } from '../src/extensions/dialog-accessory.ts';
import { PRESENTATION_DIALOG_EXTRAS, MAIN_DIALOG_EXTRAS, MAIN_DIALOG_PROTECTED, OWNED_DIALOG_PROTECTED, DIALOG_EXTRAS, DIALOG_ACTION_SURFACES, DIALOG_DATA_SURFACES, DIALOG_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const schema = read('../src/extensions/schema-v1.json');
const ledger = read('./fixtures/extensions/surfaces.json');
const manifest = read('./fixtures/extensions/core-dialogs/extension.json');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const eligible = MAIN_DIALOG_EXTRAS.map(([id]) => id), protectedIds = MAIN_DIALOG_PROTECTED.map(([id]) => id);
// R1003: the five main-hosted dialogs that accept extras from packages holding ui.presentation.
const presMain = PRESENTATION_DIALOG_EXTRAS.filter(([, , , host]) => host === 'main');
const accessory = (changes = {}) => ({ contractVersion: 1, window: 'main', dialog: 'rename-task', mount: 'main/4', revision: 7, project: 'project-1', task: 'session-1', target: 'task', ...changes });
const packages = value => validateContract('packages', [value]);

test('Core dialogs: every main.ts modal ledger entry is eligible or protected with its reason; others are led by T56C', () => {
  const members = ledger.families.find(family => family.id === 'panda.dialog').members;
  const mainMembers = members.filter(([, owner]) => owner === 'src/main.ts').map(([id]) => id);
  assert.deepEqual([...eligible, ...presMain.map(([id]) => id), ...protectedIds].sort(), [...mainMembers].sort());
  assert.equal(new Set([...eligible, ...presMain.map(([id]) => id), ...protectedIds]).size, eligible.length + presMain.length + protectedIds.length);
  for (const [, title, reason] of MAIN_DIALOG_PROTECTED) assert.ok(title && reason.length > 30);
  for (const [, title, target] of MAIN_DIALOG_EXTRAS) assert.ok(title && ['none', 'task', 'project'].includes(target));
  // The coverage map has one row per ledger dialog with a lead task; T56B rows mirror the registry exactly.
  assert.deepEqual(Object.keys(ledger.dialogCoverage).sort(), members.map(([id]) => `panda.dialog.${id}`).sort());
  for (const [id, , target] of MAIN_DIALOG_EXTRAS) assert.deepEqual(ledger.dialogCoverage[`panda.dialog.${id}`], { lead: 'T56B', status: 'implemented-experimental', location: `panda.dialog.${id}`, target, tests: ['tests/extensions-core-dialogs-coverage.spec.ts'] });
  for (const [id, , target] of presMain) assert.deepEqual(ledger.dialogCoverage[`panda.dialog.${id}`], { lead: 'T56B', status: 'implemented-experimental', location: `panda.dialog.${id}`, target, tests: ['tests/extensions-core-dialogs-coverage.spec.ts'] });
  for (const [id, , reason] of MAIN_DIALOG_PROTECTED) assert.deepEqual(ledger.dialogCoverage[`panda.dialog.${id}`], { lead: 'T56B', status: 'protected', reason, tests: ['tests/extensions-core-dialogs-coverage.spec.ts'] });
  for (const [id, owner, anchor] of members.filter(([, owner]) => owner !== 'src/main.ts')) {
    assert.equal(ledger.dialogCoverage[`panda.dialog.${id}`].lead, 'T56C', `${owner} ${anchor}`);
    // Registered with the same contract or protected with a reason (tests/extensions-owned-dialogs.test.mjs).
    assert.ok(['implemented-experimental', 'protected'].includes(ledger.dialogCoverage[`panda.dialog.${id}`].status), id);
  }
  // Each eligible opener captures its stable ID; protected openers never pass one.
  for (const id of [...eligible, ...presMain.map(([dialog]) => dialog)]) assert.ok(main.includes(`{ dialog: '${id}'`), `missing accessory for ${id}`);
  for (const id of protectedIds) assert.ok(!main.includes(`dialog: '${id}'`), `protected ${id} passes an accessory`);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.dialog' && adapter.tests.includes('tests/extensions-core-dialogs-coverage.spec.ts')));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-core-dialogs-coverage\.spec\.ts/);
});

test('Core dialogs: shared schema enumerates exactly the eligible IDs for extras, actions and invocation context', () => {
  // The shared main modals come first; module-owned and directly mounted dialogs follow (T56C).
  assert.deepEqual(schema.$defs.mainDialogId.enum.slice(0, eligible.length), eligible);
  assert.deepEqual(schema.$defs.mainDialogId.enum, DIALOG_EXTRAS.map(([id]) => id));
  assert.deepEqual(schema.$defs.dialogExtra.properties.dialog, { $ref: '#/$defs/mainDialogId' });
  assert.deepEqual(schema.$defs.context.properties.dialog, { $ref: '#/$defs/mainDialogId' });
  assert.deepEqual(schema.$defs.actionLocation.enum.filter(location => location.startsWith('panda.dialog.')), DIALOG_ACTION_SURFACES);
  assert.equal(schema.$defs.manifest.properties.contributes.properties.dialogExtras.maxItems, 64);
  for (const id of protectedIds) assert.ok(!JSON.stringify(schema).includes(`"${id}"`) && !JSON.stringify(schema).includes(`panda.dialog.${id}.`), id);
  for (const id of eligible) assert.equal(isEligibleDialog(id), true);
  for (const id of [...protectedIds, 'permission', 'privacy', 'recovery', 'extension-form']) assert.equal(isEligibleDialog(id), false);
  for (const [id] of PRESENTATION_DIALOG_EXTRAS) assert.equal(isEligibleDialog(id), true, id);
});

test('Core dialogs: the installed fixture contributes to every eligible dialog; protected, unknown and oversized declarations are refused', () => {
  const before = structuredClone(manifest);
  assert.equal(packages(manifest).ok, true); assert.deepEqual(manifest, before);
  for (const id of eligible) {
    assert.ok(manifest.contributes.menus.some(menu => menu.location === `panda.dialog.${id}.actions`), id);
    assert.ok(manifest.contributes.dialogExtras.some(extra => extra.dialog === id), id);
  }
  // Shared menu, dialog/select/switch and icon contracts, not a second control vocabulary.
  const follow = manifest.contributes.commands.find(command => command.action.kind === 'showDialog');
  assert.deepEqual(follow.action.dialog.fields.map(field => field.kind), ['text', 'select', 'switch']);
  assert.ok(manifest.contributes.menus.some(menu => menu.items?.length) && manifest.contributes.menus.every(menu => menu.icon));
  for (const id of [...protectedIds, 'permission', 'recovery', 'extension-form', 'unknown']) {
    const extra = structuredClone(manifest); extra.contributes.dialogExtras[0].dialog = id; assert.equal(packages(extra).ok, false, id);
    const menu = structuredClone(manifest); menu.contributes.menus[0].location = `panda.dialog.${id}.actions`; assert.equal(packages(menu).ok, false, id);
  }
  const foreign = structuredClone(manifest); foreign.contributes.dialogExtras[0].id = 'other.owner/note'; assert.equal(packages(foreign).error.code, 'InvalidId');
  const markup = structuredClone(manifest); markup.contributes.dialogExtras[0].html = '<b>x</b>'; assert.equal(packages(markup).ok, false);
  const long = structuredClone(manifest); long.contributes.dialogExtras[0].text = 'x'.repeat(257); assert.equal(packages(long).ok, false);
  const many = structuredClone(manifest); many.contributes.dialogExtras = Array.from({ length: 65 }, (_, index) => ({ id: `sample.core-dialogs/n${index}`, dialog: 'usage', text: 'Note' })); assert.equal(packages(many).ok, false);
  const ungranted = structuredClone(manifest); ungranted.permissions = []; assert.equal(packages(ungranted).ok, false);
  assert.equal(MAX_DIALOG_BODY_EXTRAS, 8);
  // Every contributed action resolves through the shared activation for its own dialog only.
  const activation = createDeclarativeActivation({ safeMode: false, diagnostics: [], packages: [{ manifest, icons: {}, enabled: true }] }, 1);
  for (const id of eligible) assert.ok(activation.entries.some(entry => entry.menu.location === `panda.dialog.${id}.actions` && entry.command), id);
  activation.dispose();
});

test('Core dialogs: captured accessory admission refuses forged, protected, replaced, retargeted and revoked requests', () => {
  const live = accessory();
  assert.equal(validateContract('dialogAccessory', live).ok, true);
  assert.deepEqual(admitDialogAccessory(accessory(), live), { ok: true });
  for (const [change, reason] of [
    [{ mount: 'main/5' }, 'StaleContext'], [{ revision: 8 }, 'StaleContext'], [{ task: 'session-2' }, 'StaleContext'],
    [{ project: 'project-2' }, 'StaleContext'], [{ dialog: 'task-status' }, 'StaleContext'], [{ target: 'project' }, 'StaleContext'],
    [{ contractVersion: 2 }, 'UnsupportedCapability'], [{ dialog: 'github-behind' }, 'UnsupportedCapability'], [{ dialog: 'extension-form' }, 'UnsupportedCapability'],
    [{ window: 'tray' }, 'InvalidArguments'], [{ selector: '#dialog' }, 'InvalidArguments'], [{ ipc: 'raw' }, 'InvalidArguments'], [{ dialog: 'integrations-direct' }, 'InvalidArguments'], [{ mount: '' }, 'InvalidArguments'], [{ task: 'x'.repeat(257) }, 'InvalidArguments'],
  ]) assert.deepEqual(admitDialogAccessory(accessory(change), live), { ok: false, reason }, JSON.stringify(change));
  assert.deepEqual(admitDialogAccessory(accessory(), undefined), { ok: false, reason: 'Revoked' });
  assert.deepEqual(admitDialogAccessory(null, live), { ok: false, reason: 'InvalidArguments' });
});

test('Core dialogs: invocation context carries the captured dialog and omits empty project/task; native context shape agrees', () => {
  const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.dialog.rename-task.actions', ...dialogContext(accessory()) };
  assert.deepEqual(dialogContext(accessory()), { dialog: 'rename-task', revision: 7, projectId: 'project-1', sessionId: 'session-1', selection: { kind: 'task', ids: ['session-1'] } });
  assert.equal(validateContract('context', context).ok, true);
  assert.deepEqual(dialogContext(accessory({ dialog: 'colors', project: '', task: '', target: 'none' })), { dialog: 'colors', revision: 7 });
  assert.deepEqual(dialogContext(accessory({ dialog: 'moodboards', target: 'project' })).selection, { kind: 'project', ids: ['project-1'] });
  assert.equal(dialogContext(accessory({ target: 'task', task: '' })).selection, undefined);
  for (const dialog of ['extension-form', 'github-behind', 'unknown']) assert.equal(validateContract('context', { ...context, dialog }).ok, false);
  const kinds = schema.$defs.context.properties.selection.properties.kind.enum;
  for (const [, , target] of MAIN_DIALOG_EXTRAS) if (target !== 'none') assert.ok(kinds.includes(target));
});

test('Core dialogs: catalog lists every eligible slot with its item types and the protected dialogs as inspect-only', () => {
  const catalog = createUiCatalog(() => ({ safeMode: false, diagnostics: [], packages: [{ manifest, icons: {}, enabled: true }] }));
  const all = query => { const items = []; let cursor; do { const page = catalog[query.kind]({ ...query.filter, limit: 100, ...(cursor ? { cursor } : {}) }); items.push(...page.items); cursor = page.nextCursor; } while (cursor); return items; };
  const surfaces = all({ kind: 'listSurfaces', filter: {} });
  for (const location of DIALOG_ACTION_SURFACES) assert.deepEqual(surfaces.find(surface => surface.id === location)?.supportedItemTypes, ['button', 'menu-trigger', 'status', 'badge']);
  for (const location of DIALOG_DATA_SURFACES) assert.deepEqual(surfaces.find(surface => surface.id === location)?.supportedOperations, ['inspect', 'contribute']);
  assert.deepEqual(surfaces.find(surface => surface.id === DIALOG_PROTECTED_LOCATION)?.supportedOperations, ['inspect']);
  const protectedItems = all({ kind: 'listItems', filter: { location: DIALOG_PROTECTED_LOCATION } });
  assert.deepEqual(protectedItems.map(item => item.id), [...MAIN_DIALOG_PROTECTED, ...OWNED_DIALOG_PROTECTED].map(([id]) => `${DIALOG_PROTECTED_LOCATION}/${id}`).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — /); }
  const contributed = all({ kind: 'listItems', filter: { owner: manifest.id } });
  assert.ok(contributed.some(item => item.location === 'panda.dialog.rename-task.actions' && item.type === 'menu-trigger'));
  assert.ok(contributed.every(item => item.location.startsWith('panda.dialog.') && !protectedIds.some(id => item.location.includes(`.${id}.`))));
});
