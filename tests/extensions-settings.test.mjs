import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSettingsPresentation, snapshotSettings, SETTINGS_ENTRY_CONTROLS, SETTINGS_NETWORK_CONTROLS, SETTINGS_REGISTRY } from '../src/extensions/settings-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { SETTINGS_CORE_CONTROLS, SETTINGS_PROTECTED_CONTROLS, SETTINGS_PINNED_SECTIONS, SETTINGS_FIELD_PAGES, SETTINGS_PROTECTED_LOCATION, SETTINGS_SECTIONS_LOCATION, SETTINGS_CONTROLS_LOCATION } from '../src/extensions/surfaces.ts';
import { SECTIONS } from '../src/settings-sections.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/settings-core/${name}.json`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.settings-core/actions-first', active: true, granted: true, userChoice: true, ...changes });
const pages = SECTIONS.flatMap(section => section.pages.map(page => page.id));

test('Settings registry: every existing core page has an explicit entry, each exception has its reason, and the ledger maps it', () => {
  assert.deepEqual(SETTINGS_REGISTRY.map(entry => entry.page), pages);
  for (const entry of SETTINGS_REGISTRY) {
    assert.equal(entry.section, SECTIONS.find(section => section.pages.some(page => page.id === entry.page)).id);
    assert.ok(entry.order && entry.actions && entry.context);
    assert.equal(entry.hide, !Object.hasOwn(SETTINGS_PINNED_SECTIONS, entry.section));
    if (!entry.hide) assert.ok(entry.hideReason.length > 20); else assert.equal(entry.hideReason, undefined);
    if (!entry.fields) assert.ok(entry.fieldsReason.length > 10); else assert.ok(SETTINGS_FIELD_PAGES.includes(entry.page));
    for (const id of entry.protected) assert.ok(SETTINGS_PROTECTED_CONTROLS.some(([control, , page, reason]) => control === id && page === entry.page && reason.length > 20));
  }
  // Every protected credential/grant/pairing/recovery control names the page where it stays reachable.
  for (const [, , page] of SETTINGS_PROTECTED_CONTROLS) assert.ok(pages.includes(page));
  for (const [, , page] of SETTINGS_CORE_CONTROLS) assert.ok(pages.includes(page));
  for (const section of ['voice', 'agents', 'connections', 'extensions', 'about']) assert.ok(SETTINGS_PINNED_SECTIONS[section]);
  const row = ledger.settingsCoverage['panda.settings.pages'];
  assert.deepEqual(row.pages, Object.fromEntries(SETTINGS_REGISTRY.map(entry => [entry.page, JSON.parse(JSON.stringify(entry))])));
  assert.deepEqual(row.members, schema.$defs.settingsControlId.enum); assert.deepEqual(row.protected, SETTINGS_PROTECTED_CONTROLS.map(([id]) => id));
  assert.deepEqual(row.sections, SECTIONS.map(section => section.id));
  // The ledger's original Settings family lists exactly the pages this registry covers.
  assert.deepEqual(ledger.families.find(family => family.id === 'panda.settings.pages').members.map(([id]) => id).sort(), [...pages].sort());
  assert.deepEqual([...schema.$defs.settingsPageId.enum].sort(), [...pages, 'extension'].sort());
  assert.deepEqual([...schema.$defs.settingsSectionId.enum].sort(), [...SECTIONS.map(section => section.id), 'extension'].sort());
  assert.deepEqual(schema.$defs.settingsPage.properties.section.enum, [...SETTINGS_FIELD_PAGES]);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.settings' && adapter.tests.includes('tests/extensions-settings-coverage.spec.ts')));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-settings-coverage\.spec\.ts/);
});

test('Settings schema, package, selected recipe, bounded catalog, pinned sections, protected controls and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'preferences'] }, { presentation: 'controls-first' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  for (const location of [SETTINGS_PROTECTED_LOCATION, 'panda.settings.pages']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false);
  }
  // Shared fields only join eligible core pages; credential, recovery and checklist pages refuse them.
  for (const section of ['providers', 'voice', 'agents', 'extensions', 'about', 'remote', 'github', 'cloud', 'recommended', 'routing', 'general/../providers']) {
    const forged = structuredClone(manifest); forged.contributes.settings[0].section = section; assert.equal(validateContract('packages', [forged]).ok, false, section);
  }
  for (const section of SETTINGS_FIELD_PAGES) { const placed = structuredClone(manifest); placed.contributes.settings[0].section = section; assert.equal(validateContract('packages', [placed]).ok, true); }
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.settings.actions', revision: 1, selection: { kind: 'settings-page', ids: ['general'] } }).ok, true);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.settings', [provider]), undefined); selection.select('panda.settings', provider.id, [provider]); assert.equal(selection.resolve('panda.settings', [provider]), provider); assert.equal(selection.resolve('panda.settings', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.settings' }).items.map(item => item.supportedItemTypes), [['actions-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: SETTINGS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const location of ['panda.settings.actions', 'panda.settings.context']) assert.ok(catalog.listSurfaces({ location }).items[0].supportedOperations.includes('contribute'));
  const sections = catalog.listItems({ location: SETTINGS_SECTIONS_LOCATION, limit: 100 }).items;
  assert.deepEqual(sections.map(item => item.id).sort(), SECTIONS.map(section => `${SETTINGS_SECTIONS_LOCATION}/${section.id}`).sort());
  for (const item of sections) assert.deepEqual(item.supportedOperations, Object.hasOwn(SETTINGS_PINNED_SECTIONS, item.id.split('/')[1]) ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder']);
  const controls = catalog.listItems({ location: SETTINGS_CONTROLS_LOCATION, limit: 100 }).items;
  assert.deepEqual(controls.map(item => item.id).sort(), SETTINGS_CORE_CONTROLS.map(([id]) => `${SETTINGS_CONTROLS_LOCATION}/${id}`).sort());
  for (const item of controls) { assert.deepEqual(item.supportedOperations, ['inspect', 'hide', 'show', 'reorder']); layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
  const protectedItems = catalog.listItems({ location: SETTINGS_PROTECTED_LOCATION, limit: 100 }).items;
  assert.equal(protectedItems.length, SETTINGS_PROTECTED_CONTROLS.length);
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  const ids = controls.map(item => item.id); layout.move(SETTINGS_CONTROLS_LOCATION, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(SETTINGS_CONTROLS_LOCATION, ids)[0], ids[1]);
  assert.throws(() => layout.move(SETTINGS_PROTECTED_LOCATION, ['panda.settings.protected/turn-checks', 'panda.settings.protected/safe-mode'], { id: 'panda.settings.protected/safe-mode', target: 'panda.settings.protected/turn-checks', side: 'before' }));
  for (const change of [{ controls: Array(65).fill(fixture('state').controls[0]) }, { sections: Array(33).fill(fixture('state').sections[0]) }, { selector: 'body' }, { secret: 'x' }, { window: 'tray' }, { contractVersion: 2 }, { page: 'secrets' }, { section: 'credentials' }, { project: 'x'.repeat(257) }]) assert.equal(validateContract('settingsPresentation', { ...fixture('state'), ...change }).ok, false);
  assert.throws(() => snapshotSettings({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  assert.equal(validateContract('settingsPresentation', fixture('state')).ok, true); assert.equal(validateContract('settingsAction', fixture('action')).ok, true);
});

test('Settings binds owner/window/mount/project/page/revision, busy, offline, hidden and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createSettingsPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'page', 'revision']) {
    const value = key === 'revision' ? 4 : key === 'page' ? 'appearance' : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { controlId: 'expand-tool-activity' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  // A control listed on another page is a different target, even with the same handle.
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], page: 'appearance' }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), offline: true }; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'offline-local' }).ok, true); live = fixture('state');
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], enabled: false }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], hidden: true }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/actions-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.settings-core/actions-first';
  for (const change of [{ selector: 'body' }, { controlId: 'turn-checks' }, { controlId: 'provider-credentials' }, { controlId: 'safe-mode' }, { controlId: 'remove-project' }, { value: true }, { key: 'pandacode.compact' }, { window: 'tray' }, { page: 'secrets' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  assert.equal(calls.length, 2); assert.ok(Object.isFrozen(calls[0]));
});

test('Settings metadata never grants preference or external authority; only the support link needs the network', () => {
  for (const controlId of SETTINGS_ENTRY_CONTROLS) {
    const state = fixture('state'); state.controls[0].controlId = controlId;
    const slot = createSettingsPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), controlId }).reason, 'PermissionDenied');
  }
  for (const controlId of SETTINGS_NETWORK_CONTROLS) {
    const state = { ...fixture('state'), offline: true, controls: [{ ...fixture('state').controls[0], controlId }] };
    assert.equal(createSettingsPresentation(state, 'owner', () => state, () => authority({ owner: 'owner' }), () => assert.fail('offline dispatch')).dispatch({ ...fixture('action'), controlId }).reason, 'Offline');
  }
  // No protected control is a public action id.
  for (const [id] of SETTINGS_PROTECTED_CONTROLS) assert.ok(!schema.$defs.settingsControlId.enum.includes(id) && !validateContract('settingsAction', { ...fixture('action'), controlId: id }).ok);
  assert.deepEqual(schema.$defs.settingsControlId.enum, SETTINGS_CORE_CONTROLS.map(([id]) => id));
});
