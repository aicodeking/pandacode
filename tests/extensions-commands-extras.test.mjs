import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommandsControls, snapshotCommands, packageSlashEntries, slashArguments, COMMANDS_CONTROL_IDS, COMMANDS_CHOICE_CONTROLS, COMMANDS_PROTECTED_CONTROLS, COMMANDS_REGISTRY } from '../src/extensions/commands-core.ts';
import { validateContract, MANIFEST_CONTRIBUTIONS } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { COMMANDS_ACTION_SURFACES, SLASH_LOCATION, HARNESS_LOCATION, SLASH_PACKAGE_LOCATION, COMMANDS_PROTECTED_LOCATION, SLASH_ENTRIES, HARNESS_ENTRIES, COMMANDS_PINNED, COMMANDS_PROTECTED } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/commands-extras/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const SLASH_UNSUPPORTED = /export const SLASH_UNSUPPORTED = '([^']+)';/.exec(read('../src/extensions/provider-cli.ts'))[1];
const authority = (changes = {}) => ({ owner: 'sample.commands-extras/toolbar', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.commands.harness', 'panda.commands.slash'];
const CONTROLS = [[SLASH_LOCATION, SLASH_ENTRIES], [HARNESS_LOCATION, HARNESS_ENTRIES]];

test('Commands registry: each owned member has public locations, operations and an extension hook in its source, and the ledger closes exactly the two gaps', () => {
  assert.deepEqual(COMMANDS_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.commands.harness', 'src/command-center.ts'], ['panda.commands.slash', 'src/main.ts']]);
  for (const entry of COMMANDS_REGISTRY) {
    assert.ok(entry.actions && entry.order && entry.hide && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    const local = entry.member.slice('panda.commands.'.length);
    assert.ok(ledger.families.find(item => item.id === 'panda.commands').members.some(([id, owner]) => id === local && owner === entry.source), entry.member);
  }
  // T60's audit found the command center with a dialog band only and every package slash command refused; each now
  // carries the adapter's hook.
  assert.match(read('../src/command-center.ts'), /extension\?: CommandCenterExtension/);
  const main = read('../src/main.ts');
  assert.match(main, /mountCommandsAdoption\(\{/);
  assert.match(main, /commandsAdoption\?\.slashCatalog\(catalog, s\.id\) \?\? catalog/);
  assert.match(main, /const packageSlash = commandsAdoption\?\.slashCommand\(text, s\.id\);/);
  assert.match(main, /extension: commandsAdoption\?\.centerExtension\(/);
  assert.deepEqual([...COMMANDS_CONTROL_IDS], schema.$defs.commandsControlId.enum);
  const row = ledger.commandsCoverage['panda.commands.extras'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.commands.extras'); assert.equal(row.lead, 'T60G');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: every other coverage block keeps its own keys.
  for (const [key, block] of Object.entries(ledger).filter(([key]) => key.endsWith('Coverage'))) for (const [id, entry] of Object.entries(block)) if (!(key === 'commandsCoverage' && id === 'panda.commands.extras')) assert.equal([entry?.closes ?? []].flat().filter(gap => GAPS.includes(gap)).length, 0, `${key}.${id}`);
  assert.deepEqual(row.members, [...COMMANDS_CONTROL_IDS]);
  assert.deepEqual(row.slashEntries, SLASH_ENTRIES.map(([id]) => id)); assert.deepEqual(row.harnessEntries, HARNESS_ENTRIES.map(([id]) => id));
  assert.deepEqual(row.protected, COMMANDS_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...COMMANDS_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'conflict', 'move', 'replacement', 'boundary', 'slashCommand']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.commands.extras').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.commands.extras').tests.includes('tests/extensions-commands-extras-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-commands-extras-coverage\.spec\.ts/);
  assert.match(read('../playwright.webkit.config.ts'), /\|Commands extension:/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/commands-host.ts'), ['src/extensions/commands-host.ts', [], 0, 1]);
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'commands-extension-entry' && owner === 'src/extensions/commands-host.ts'));
  for (const local of ['harness', 'slash']) {
    const [, owner, anchor] = ledger.families.find(family => family.id === 'panda.commands').members.find(([id]) => id === local);
    assert.ok(read(`../${owner}`).includes(anchor), local);
  }
  // A slash command receives the arguments typed after its name, never the draft: the host passes parsed arguments only.
  const host = read('../src/extensions/commands-host.ts');
  assert.match(host, /arguments: parsed\.arguments/);
  assert.doesNotMatch(host, /draft: state\.draft/);
});

test('Commands manifests: slash declarations validate name, description, argument schema and one target, identically to the native validator', () => {
  const manifest = fixture('extension'), provider = fixture('provider');
  assert.ok(MANIFEST_CONTRIBUTIONS.includes('slashCommands'));
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(validateContract('packages', [provider]).ok, true);
  for (const component of manifest.contributes.components) assert.equal(componentIncompatibility(component), undefined, component.id);
  const invalid = (change) => { const value = structuredClone(manifest); change(value.contributes.slashCommands[0], value); return validateContract('packages', [value]); };
  for (const [field, value] of [['name', 'notes'], ['name', '/Notes'], ['name', `/${'a'.repeat(33)}`], ['description', ''], ['arguments', { required: true }], ['arguments', { required: false, maxLength: 0 }], ['arguments', { required: false, maxLength: 2049 }], ['arguments', { required: false, maxLength: 10, pattern: '.*' }], ['script', 'run']]) assert.equal(invalid(slash => { slash[field] = value; }).ok, false, `${field} ${JSON.stringify(value)}`);
  assert.equal(invalid(slash => { slash.provider = 'sample.commands-extras/missing'; }).error.code, 'InvalidShape');
  assert.equal(invalid(slash => { delete slash.command; }).error.code, 'InvalidShape');
  assert.equal(invalid(slash => { slash.command = 'sample.commands-extras/missing'; }).error.code, 'UnknownReference');
  assert.equal(invalid((slash, value) => { value.contributes.slashCommands[1].name = '/notes'; }).error.code, 'DuplicateId');
  assert.equal(invalid(slash => { slash.id = 'other.owner/notes'; }).error.code, 'InvalidId');
  const foreign = structuredClone(provider); foreign.contributes.slashCommands[0].provider = 'sample.fake-harness/recorded';
  assert.equal(validateContract('packages', [foreign]).error.code, 'UnknownReference');
  const noPermission = structuredClone(manifest); noPermission.permissions = ['ui.customize']; assert.equal(validateContract('packages', [noPermission]).ok, false);
  // The SDK declares the same shape the schema does; the native mirror is checked by contracts.rs and packages.rs.
  const sdk = read('../src/extensions/sdk/index.d.ts');
  assert.match(sdk, /export interface SlashCommandDefinition \{ readonly id: string; readonly name: string; readonly description: string; readonly command\?: string; readonly provider\?: string; readonly arguments\?: \{ readonly hint\?: string; readonly required: boolean; readonly maxLength: number \} \}/);
  assert.deepEqual(Object.keys(schema.$defs.slashCommand.properties), ['id', 'name', 'description', 'command', 'provider', 'arguments']);
  assert.deepEqual(Object.keys(schema.$defs.slashArguments.properties), ['hint', 'required', 'maxLength']);
  const native = read('../src-tauri/src/extensions/contracts.rs');
  assert.match(native, /"providers", "slashCommands"(, "companions")?\];/);
  assert.match(native, /for slash in items\(contributions, "slashCommands"\)/);
  assert.match(read('../src-tauri/src/extensions/packages.rs'), /fn commands_extras_archive_install_restart_disable_and_safe_mode/);
  // SLASH_UNSUPPORTED is no longer a blanket refusal: it names the one unsupported case, the same in TS and Rust.
  assert.match(SLASH_UNSUPPORTED, /does not advertise this slash command/);
  assert.ok(read('../src-tauri/src/extensions/providers.rs').includes(`pub const SLASH_UNSUPPORTED: &str = "${SLASH_UNSUPPORTED}";`));
  const preview = read('../src/preview.ts');
  assert.match(preview, /warnings: advertised\.length \? \[\] : \[SLASH_UNSUPPORTED\]/);
  assert.match(read('../src-tauri/src/slash_commands.rs'), /if catalog\.commands\.is_empty\(\) \{ catalog\.warnings\.push\(crate::extensions::providers::SLASH_UNSUPPORTED\.into\(\)\); \}/);
});

test('Commands catalog: slash and harness entries list their operations; package slash commands are owned items; layouts are reversible', () => {
  const manifest = fixture('extension');
  for (const [kind, surfaceId, ids] of [['slash-command', 'panda.commands.slash', ['task-1']], ['harness-command', 'panda.commands.harness.actions', ['codex:usage']]]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids }, ...(kind === 'slash-command' ? { slash: { command: 'sample.commands-extras/notes', provider: 'codex', arguments: 'release' } } : {}) }).ok, true, kind);
  }
  const slash = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands.slash', revision: 1, slash: { command: 'sample.commands-extras/notes', provider: 'codex', arguments: 'x' } };
  assert.equal(validateContract('context', { ...slash, slash: { ...slash.slash, arguments: 'x'.repeat(2049) } }).ok, false);
  assert.equal(validateContract('context', { ...slash, slash: { ...slash.slash, draft: 'the rest of the composer' } }).ok, false);
  assert.equal(validateContract('context', { ...slash, selection: { kind: 'slash-draft', ids: ['task-1'] } }).ok, false);
  for (const location of COMMANDS_ACTION_SURFACES) { assert.ok(schema.$defs.actionLocation.enum.includes(location)); assert.ok(actionLocations.includes(location)); }
  for (const [location] of CONTROLS) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [COMMANDS_PROTECTED_LOCATION, SLASH_PACKAGE_LOCATION, 'panda.commands']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreignRule = structuredClone(manifest); foreignRule.contributes.layouts[0].rules[0].id = 'panda.commands.harness.entries/usage'; assert.equal(validateContract('packages', [foreignRule]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.commands.harness.actions' }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder']);
  assert.deepEqual(catalog.listSurfaces({ location: SLASH_PACKAGE_LOCATION }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show']);
  assert.deepEqual(catalog.listSurfaces({ location: SLASH_PACKAGE_LOCATION }).items[0].supportedItemTypes, ['slash-command']);
  for (const [location] of CONTROLS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: COMMANDS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const [location, entries] of CONTROLS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), entries.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      const pinned = COMMANDS_PINNED[item.id];
      assert.deepEqual(item.supportedOperations, pinned ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder'], item.id);
      if (pinned) assert.match(item.label, / — .{20,}/);
    }
  }
  assert.deepEqual(Object.keys(COMMANDS_PINNED), [`${SLASH_LOCATION}/help`]);
  const protectedItems = catalog.listItems({ location: COMMANDS_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), COMMANDS_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  // The draft and the command center's panels are never layout items.
  const layoutIds = CONTROLS.flatMap(([location, entries]) => entries.map(([id]) => `${location}/${id}`));
  for (const id of ['draft', 'caret', 'send', 'panel']) assert.ok(!layoutIds.some(item => item.endsWith(`/${id}`)), id);
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.commands-extras/harness', 'panda.commands.harness.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.commands-extras/notes', SLASH_PACKAGE_LOCATION, ['inspect', 'hide', 'show']],
    ['sample.commands-extras/ping-slash', SLASH_PACKAGE_LOCATION, ['inspect', 'hide', 'show']],
  ]);
  assert.deepEqual(createUiCatalog(() => ({ safeMode: true, packages: [] })).listItems({ location: SLASH_PACKAGE_LOCATION }).items, []);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const id of layoutIds.filter(id => !COMMANDS_PINNED[id])) { layout.setVisible(id, false); assert.equal(layout.isHidden(id), true); layout.setVisible(id, true); assert.equal(layout.isHidden(id), false); }
  const entries = ['usage', 'goal'].map(id => `${HARNESS_LOCATION}/${id}`); layout.move(HARNESS_LOCATION, entries, { id: entries[0], target: entries[1], side: 'after' }); assert.equal(layout.order(HARNESS_LOCATION, entries)[0], entries[1]);
});

test('Package slash commands: conflicts keep PandaCode and harness names, arguments follow the declared schema', () => {
  const declarations = fixture('extension').contributes.slashCommands;
  const entries = packageSlashEntries([{ id: 'sample.commands-extras', commands: declarations }], new Set(['/rename', '/usage']));
  assert.deepEqual(entries.map(({ entry }) => [entry.name, entry.kind, entry.source]), [['/notes', 'action', 'sample.commands-extras'], ['/ping', 'action', 'sample.commands-extras']]);
  assert.equal(entries[0].entry.argumentHint, '[topic]');
  // A host or harness name wins; a name two packages declare runs neither.
  const taken = packageSlashEntries([{ id: 'sample.commands-extras', commands: [{ ...declarations[0], name: '/rename' }] }], new Set(['/rename']));
  assert.equal(taken[0].entry.kind, 'unsupported'); assert.equal(taken[0].declaration, undefined); assert.match(taken[0].entry.reason, /^Conflict: \/rename/);
  const twice = packageSlashEntries([{ id: 'sample.commands-extras', commands: [declarations[0]] }, { id: 'other.commands', commands: [{ ...declarations[0], id: 'other.commands/notes' }] }], new Set());
  assert.deepEqual(twice.map(({ entry, declaration }) => [entry.kind, Boolean(declaration)]), [['unsupported', false], ['unsupported', false]]);
  // Provider declarations are listed by the native catalog for their provider, never as package command entries.
  assert.deepEqual(packageSlashEntries([{ id: 'sample.slash-harness', commands: fixture('provider').contributes.slashCommands }], new Set()), []);
  const [notes, ping] = declarations;
  assert.deepEqual(slashArguments(notes, '/notes   release plan  '), { ok: true, arguments: 'release plan' });
  assert.deepEqual(slashArguments(notes, '/notes'), { ok: true, arguments: '' });
  assert.equal(slashArguments(notes, `/notes ${'x'.repeat(201)}`).ok, false);
  assert.equal(slashArguments({ ...notes, arguments: { ...notes.arguments, required: true } }, '/notes').ok, false);
  assert.deepEqual(slashArguments(ping, '/ping'), { ok: true, arguments: '' });
  assert.match(slashArguments(ping, '/ping now').reason, /does not accept arguments/);
  assert.equal(slashArguments(ping, '/pings').ok, false);
});

test('Commands bind owner/window/mount/project/task/harness/revision and the panel; protected, busy, hidden and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createCommandsControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  assert.equal(validateContract('commandsPresentation', live).ok, true); assert.equal(validateContract('commandsAction', fixture('action')).ok, true);
  for (const key of ['context', 'project', 'task', 'provider', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { controlId: 'harness-close' }, { resource: 'panel-hooks' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.controlId !== 'harness-refresh') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: control.controlId === 'harness-refresh' })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/toolbar'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.commands-extras/toolbar';
  // Sending, writing or reading the draft, panel changes and consoles are named as protected and never run.
  for (const controlId of COMMANDS_PROTECTED_CONTROLS) for (const control of ['control-refresh', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, text: '/notes hello' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '.slash-menu' }, { controlId: 'slash-run' }, { text: 'hello' }, { arguments: 'x' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0])); assert.equal(calls[0].controlId, 'harness-refresh');
  // Opening a panel needs the fresh host choice; Refresh and Done act on the panel the user opened.
  const state = fixture('state'), guarded = createCommandsControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => assert.notEqual(action.controlId, 'harness-open'));
  assert.equal(guarded.dispatch({ ...fixture('action'), control: 'control-open-usage', controlId: 'harness-open', resource: 'panel-usage', requestId: 'open' }).reason, 'PermissionDenied');
  assert.deepEqual(guarded.dispatch({ ...fixture('action'), control: 'control-close', controlId: 'harness-close', resource: 'panel-usage', requestId: 'close' }), { ok: true });
  assert.deepEqual(COMMANDS_CHOICE_CONTROLS, ['harness-open']);
  for (const id of [...COMMANDS_PROTECTED.map(([id]) => id), ...COMMANDS_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.commandsControlId.enum.includes(id), id);
  // Bounded JSON only: no draft text, typed names, panel contents or catalog cross the presentation.
  for (const change of [{ controls: Array(65).fill(state.controls[0]) }, { selector: '.slash-menu' }, { draft: '/notes secret' }, { commands: ['/notes'] }, { panel: 'console' }, { slash: 33 }, { window: 'tray' }, { contractVersion: 2 }]) assert.equal(validateContract('commandsPresentation', { ...state, ...change }).ok, false, JSON.stringify(change).slice(0, 40));
  for (const extra of [{ label: '/usage' }, { name: 'usage' }]) assert.equal(validateContract('commandsPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  assert.throws(() => snapshotCommands({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});
