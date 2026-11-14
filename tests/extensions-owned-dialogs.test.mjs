import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { admitDialogAccessory, dialogContext, isEligibleDialog, ownedDialogAccessory } from '../src/extensions/dialog-accessory.ts';
import { MAIN_DIALOG_EXTRAS, OWNED_DIALOG_EXTRAS, OWNED_DIALOG_ALIASES, OWNED_DIALOG_PROTECTED, DIALOG_ACTION_SURFACES, DIALOG_DATA_SURFACES, DIALOG_PROTECTED_LOCATION, dialogTarget, isOwnedDialog } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const schema = read('../src/extensions/schema-v1.json');
const ledger = read('./fixtures/extensions/surfaces.json');
const manifest = read('./fixtures/extensions/owned-dialogs/extension.json');
const members = ledger.families.find(family => family.id === 'panda.dialog').members.filter(([, owner]) => owner !== 'src/main.ts');
const ownedIds = OWNED_DIALOG_EXTRAS.map(([id]) => id), aliasIds = OWNED_DIALOG_ALIASES.map(([id]) => id), protectedIds = OWNED_DIALOG_PROTECTED.map(([id]) => id);
const packages = value => validateContract('packages', [value]);
const SPEC = 'tests/extensions-owned-dialogs-coverage.spec.ts';

test('Owned dialogs: every module-owned and direct ledger row is registered, an alias of its main dialog, or protected with a reason', () => {
  assert.deepEqual([...ownedIds, ...aliasIds, ...protectedIds].sort(), members.map(([id]) => id).sort());
  assert.equal(new Set([...ownedIds, ...aliasIds, ...protectedIds]).size, members.length);
  for (const [id, title, target, host] of OWNED_DIALOG_EXTRAS) {
    assert.ok(title && ['none', 'task', 'project'].includes(target) && ['module', 'direct'].includes(host), id);
    const [, owner, anchor] = members.find(([member]) => member === id);
    // A module host reaches the shared modal; a direct host mounts its own dialog element.
    assert.equal(host, anchor.startsWith('modal(') ? 'module' : 'direct', `${owner} ${anchor}`);
    assert.deepEqual(ledger.dialogCoverage[`panda.dialog.${id}`], { lead: 'T56C', status: 'implemented-experimental', location: `panda.dialog.${id}`, target, tests: [SPEC] });
    assert.equal(dialogTarget(id), target); assert.equal(isOwnedDialog(id), true); assert.equal(isEligibleDialog(id), true);
  }
  for (const [id, main] of OWNED_DIALOG_ALIASES) {
    assert.ok(MAIN_DIALOG_EXTRAS.some(([dialog]) => dialog === main), id);
    assert.deepEqual(ledger.dialogCoverage[`panda.dialog.${id}`], { lead: 'T56C', status: 'implemented-experimental', location: `panda.dialog.${main}`, alias: main, tests: [SPEC] });
    assert.equal(isEligibleDialog(id), false);
  }
  for (const [id, title, reason] of OWNED_DIALOG_PROTECTED) {
    assert.ok(title && reason.length > 40, id);
    assert.deepEqual(ledger.dialogCoverage[`panda.dialog.${id}`], { lead: 'T56C', status: 'protected', reason, tests: [SPEC] });
    assert.equal(isEligibleDialog(id), false);
  }
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-owned-dialogs-coverage\.spec\.ts/);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.dialog' && adapter.tests.includes(SPEC) && adapter.tests.includes('tests/extensions-owned-dialogs.test.mjs')));
});

test('Owned dialogs: each owner passes its own dialog ID and target; protected and alias owners never register a second band', () => {
  const owners = Object.fromEntries(members.map(([id, owner]) => [id, owner]));
  // Module hosts pass the request to the shared modal helper with the target they own.
  const requests = {
    'agent-updates': "{ dialog: 'agent-updates' }", 'channel-create': "{ dialog: 'channel-create' }", 'channel-settings': "{ dialog: 'channel-settings' }",
    'github-import': "{ dialog: 'github-import', project: projectId }", 'github-pr': "{ dialog: 'github-pr', task: session.id, project: session.projectId }",
    'github-link': "{ dialog: 'github-link', task: session.id, project: session.projectId }", sketch: "{ dialog: 'sketch', task: options.taskId }",
    'worktree-create': "{ dialog: 'worktree-create', task: session.id, project: session.projectId }",
  };
  for (const [id, request] of Object.entries(requests)) assert.ok(source(owners[id]).includes(request), id);
  // Direct hosts attach the band to the dialog they mounted, with their own owner node.
  assert.match(source('src/command-center.ts'), /attachDialogExtras\(dialog, \{ dialog: 'command-center', \.\.\.target \}, \{ owner: host/);
  assert.match(source('src/progress-lightbox.ts'), /attachDialogExtras\(dialog, \{ dialog: 'progress-lightbox'/);
  assert.match(source('src/team-model-add.ts'), /attachDialogExtras\(dialog, \{ dialog: 'team-model-add' \}/);
  assert.match(source('src/progress-pip.ts'), /fromPointer, task: sessionId/);
  // Direct mounts of a main dialog's view attach only when they opened the dialog themselves, with the main ID.
  assert.match(source('src/integrations.ts'), /if \(!dialog\.open\) \{ dialog\.showModal\(\); attachDialogExtras\(dialog, \{ dialog: 'integrations'/);
  assert.match(source('src/jev-assist.ts'), /if \(!dialog\.open\) \{ dialog\.showModal\(\); attachDialogExtras\(dialog, \{ dialog: 'jev-assist'/);
  assert.match(source('src/jev.ts'), /createView\(dialog, 'Test with Jev', 'jev-tests-dialog', \{ dialog: 'jev-tests'/);
  for (const id of aliasIds) for (const path of ['src/integrations.ts', 'src/jev-assist.ts', 'src/jev.ts', 'src/main.ts']) assert.ok(!source(path).includes(`dialog: '${id}'`), id);
  // Protected owners pass nothing: the permission, destructive, security and package-form dialogs stay host-only.
  assert.ok(!source('src/machine-orchestration.ts').includes('DialogRequest') && !source('src/machine-orchestration.ts').includes("dialog: '"));
  assert.ok(!source('src/skill-manager-add.ts').includes('owned-dialogs') && !source('src/skill-manager-add.ts').includes("dialog: '"));
  assert.match(source('src/worktrees.ts'), /host\.modal\(verb, `[^`]*`, 'compact-dialog worktree-dialog'\);/);
  assert.ok(!source('src/extensions/dialogs.ts').includes('mountMainDialogExtras') && !source('src/extensions/dialogs.ts').includes('attachDialogExtras'));
  // The main modal helper captures a module-owned dialog's task only from its module's request.
  assert.match(source('src/main.ts'), /const owned = isOwnedDialog\(request\.dialog\);\n  const task = owned \? request\.task \?\? '' :/);
});

test('Owned dialogs: the shared schema, SDK and catalog add exactly the registered IDs; protected and alias IDs stay out', () => {
  assert.deepEqual(schema.$defs.mainDialogId.enum.slice(-ownedIds.length), ownedIds);
  assert.deepEqual(schema.$defs.actionLocation.enum.filter(location => location.startsWith('panda.dialog.')), DIALOG_ACTION_SURFACES);
  for (const id of ownedIds) { assert.ok(DIALOG_ACTION_SURFACES.includes(`panda.dialog.${id}.actions`)); assert.ok(DIALOG_DATA_SURFACES.includes(`panda.dialog.${id}.bodyExtras`)); }
  for (const id of [...protectedIds, ...aliasIds]) assert.ok(!JSON.stringify(schema).includes(`"${id}"`) && !JSON.stringify(schema).includes(`panda.dialog.${id}.`), id);
  const sdk = source('src/extensions/sdk/index.d.ts');
  for (const id of ownedIds) assert.ok(sdk.includes(`'${id}'`), id);
  for (const id of protectedIds) assert.ok(!sdk.includes(`'${id}'`), id);
  const catalog = createUiCatalog(() => ({ safeMode: false, diagnostics: [], packages: [{ manifest, icons: {}, enabled: true }] }));
  const all = query => { const items = []; let cursor; do { const page = catalog[query.kind]({ ...query.filter, limit: 100, ...(cursor ? { cursor } : {}) }); items.push(...page.items); cursor = page.nextCursor; } while (cursor); return items; };
  const surfaces = all({ kind: 'listSurfaces', filter: {} });
  for (const id of ownedIds) {
    assert.deepEqual(surfaces.find(surface => surface.id === `panda.dialog.${id}.actions`)?.supportedItemTypes, ['button', 'menu-trigger', 'status', 'badge'], id);
    assert.deepEqual(surfaces.find(surface => surface.id === `panda.dialog.${id}.bodyExtras`)?.supportedOperations, ['inspect', 'contribute'], id);
  }
  const protectedItems = all({ kind: 'listItems', filter: { location: DIALOG_PROTECTED_LOCATION } });
  for (const id of protectedIds) assert.deepEqual(protectedItems.find(item => item.id === `${DIALOG_PROTECTED_LOCATION}/${id}`)?.supportedOperations, ['inspect'], id);
  for (const id of protectedIds) assert.ok(ledger.catalog.coreItems.includes(`${DIALOG_PROTECTED_LOCATION}/${id}`), id);
  for (const id of ownedIds) assert.ok(ledger.catalog.surfaces.includes(`panda.dialog.${id}.actions`) && ledger.catalog.surfaces.includes(`panda.dialog.${id}.bodyExtras`), id);
});

test('Owned dialogs: the installed fixture uses the shared menu/dialog/select/switch/icon contracts; protected and alias targets are refused', () => {
  const before = structuredClone(manifest);
  assert.equal(packages(manifest).ok, true); assert.deepEqual(manifest, before);
  for (const id of [...ownedIds, ...OWNED_DIALOG_ALIASES.map(([, main]) => main)]) {
    assert.ok(manifest.contributes.menus.some(menu => menu.location === `panda.dialog.${id}.actions`), id);
    assert.ok(manifest.contributes.dialogExtras.some(extra => extra.dialog === id), id);
  }
  const follow = manifest.contributes.commands.find(command => command.action.kind === 'showDialog');
  assert.deepEqual(follow.action.dialog.fields.map(field => field.kind), ['text', 'select', 'switch']);
  assert.ok(manifest.contributes.menus.some(menu => menu.location === 'panda.dialog.command-center.actions' && menu.items?.length) && manifest.contributes.menus.every(menu => menu.icon));
  for (const id of [...protectedIds, ...aliasIds, 'unknown']) {
    const extra = structuredClone(manifest); extra.contributes.dialogExtras[0].dialog = id; assert.equal(packages(extra).ok, false, id);
    const menu = structuredClone(manifest); menu.contributes.menus[0].location = `panda.dialog.${id}.actions`; assert.equal(packages(menu).ok, false, id);
  }
  const ungranted = structuredClone(manifest); ungranted.permissions = []; assert.equal(packages(ungranted).ok, false);
  const activation = createDeclarativeActivation({ safeMode: false, diagnostics: [], packages: [{ manifest, icons: {}, enabled: true }] }, 1);
  for (const id of ownedIds) assert.ok(activation.entries.some(entry => entry.menu.location === `panda.dialog.${id}.actions` && entry.command), id);
  activation.dispose();
});

test('Owned dialogs: an accessory is captured from the host request with its own mount; no global task, retarget or forged host', () => {
  const accessory = ownedDialogAccessory({ dialog: 'command-center', task: 'session-2', project: 'project-1', revision: 5 }, 'command-center/2', 2);
  assert.deepEqual(accessory, { contractVersion: 1, window: 'main', dialog: 'command-center', mount: 'command-center/2', revision: 5, project: 'project-1', task: 'session-2', target: 'task' });
  assert.ok(Object.isFrozen(accessory)); assert.equal(validateContract('dialogAccessory', accessory).ok, true);
  // Without a revision the opening number is the revision; without a task a task dialog falls back to its project or nothing.
  assert.equal(ownedDialogAccessory({ dialog: 'team-model-add' }, 'team-model-add/3', 3).revision, 3);
  assert.deepEqual(ownedDialogAccessory({ dialog: 'team-model-add' }, 'team-model-add/3', 3), { contractVersion: 1, window: 'main', dialog: 'team-model-add', mount: 'team-model-add/3', revision: 3, project: '', task: '', target: 'none' });
  assert.equal(ownedDialogAccessory({ dialog: 'progress-lightbox' }, 'progress-lightbox/1', 1).target, 'none');
  assert.equal(ownedDialogAccessory({ dialog: 'sketch', project: 'project-1' }, 'sketch/1', 1).target, 'project');
  assert.equal(ownedDialogAccessory({ dialog: 'github-import' }, 'main/9', 9).target, 'none');
  assert.deepEqual(admitDialogAccessory(accessory, accessory), { ok: true });
  for (const [change, reason] of [
    [{ mount: 'command-center/3' }, 'StaleContext'], [{ mount: 'main/2' }, 'StaleContext'], [{ task: 'session-1' }, 'StaleContext'], [{ dialog: 'team-model-add' }, 'StaleContext'],
    [{ dialog: 'machine-link' }, 'UnsupportedCapability'], [{ dialog: 'skill-add' }, 'UnsupportedCapability'], [{ dialog: 'worktree-cleanup' }, 'UnsupportedCapability'], [{ dialog: 'extension-form' }, 'UnsupportedCapability'],
    [{ dialog: 'integrations-direct' }, 'InvalidArguments'], [{ owner: 'host' }, 'InvalidArguments'], [{ window: 'progress' }, 'InvalidArguments'],
  ]) assert.deepEqual(admitDialogAccessory({ ...accessory, ...change }, accessory), { ok: false, reason }, JSON.stringify(change));
  assert.deepEqual(admitDialogAccessory(accessory, undefined), { ok: false, reason: 'Revoked' });
  assert.deepEqual(dialogContext(accessory), { dialog: 'command-center', revision: 5, projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'task', ids: ['session-2'] } });
  assert.deepEqual(dialogContext(ownedDialogAccessory({ dialog: 'channel-settings' }, 'main/4', 4)), { dialog: 'channel-settings', revision: 4 });
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.dialog.command-center.actions', ...dialogContext(accessory) }).ok, true);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.dialog.machine-link.actions', revision: 1, dialog: 'machine-link' }).ok, false);
});
