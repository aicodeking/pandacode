import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract, PRIMITIVES, primitiveLimit } from '../src/extensions/contracts.ts';
import { createDialogState, TEXT_LIMIT } from '../src/extensions/dialog-state.ts';
import { settingsDefaults, validSettingsValues } from '../src/extensions/settings-state.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const schema = read('../src/extensions/schema-v1.json');
const manifest = read('./fixtures/extensions/primitives/extension.json');
const ledger = read('./fixtures/extensions/surfaces.json');
const native = readFileSync(new URL('../src-tauri/src/extensions/contracts.rs', import.meta.url), 'utf8');
const nativePackages = readFileSync(new URL('../src-tauri/src/extensions/packages.rs', import.meta.url), 'utf8');
const dialog = manifest.contributes.commands.find(command => command.id === 'sample.primitives/form').action.dialog;
const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, projectId: 'A', sessionId: 'A' };
const pointer = path => path.split('/').reduce((node, key) => node?.[key], schema);
/** Values a family's carrier key can take, read from the schema itself (const per alternative or an enum). */
function carrierValues({ def, key }) {
  const node = schema.$defs[def];
  return (node.anyOf ?? [node]).flatMap(alternative => { const property = alternative.properties[key]; return property.enum ?? [property.const]; });
}
const packageWith = mutate => { const value = structuredClone(manifest); mutate(value); return validateContract('packages', [value]); };

test('extensions primitives: the public declaration agrees with the schema carriers and every declared limit', () => {
  assert.equal(PRIMITIVES.contractVersion, 1);
  assert.deepEqual(PRIMITIVES, schema['x-primitives']);
  assert.ok(Object.isFrozen(PRIMITIVES) && Object.isFrozen(PRIMITIVES.families.field.kinds), 'renderers cannot mutate the shared declaration');
  assert.deepEqual(Object.keys(PRIMITIVES.families).sort(), ['action', 'command', 'field', 'icon', 'menu', 'view']);
  for (const [name, family] of Object.entries(PRIMITIVES.families)) {
    assert.deepEqual([...family.kinds].sort(), [...carrierValues(family.carrier)].sort(), name);
    assert.equal(new Set(family.kinds).size, family.kinds.length, name);
    for (const [limit, { value, at }] of Object.entries(family.limits)) {
      assert.ok(Number.isSafeInteger(value) && value > 0, `${name}.${limit}`);
      for (const path of at) assert.equal(pointer(path), value, `${name}.${limit} at ${path}`);
      // Renderer-only limits have no schema location; every other limit is enforced by both validators.
      if (!at.length) assert.ok(['field.rowsDefault', 'field.query'].includes(`${name}.${limit}`), `${name}.${limit}`);
    }
  }
  const rows = PRIMITIVES.families.field.limits;
  assert.ok(rows.rowsMin.value <= rows.rowsDefault.value && rows.rowsDefault.value <= rows.rowsMax.value);
  assert.equal(TEXT_LIMIT, 4096); assert.equal(primitiveLimit('menu', 'depth'), schema['x-menuLimits'].depth);
  // The native half reads the same declaration instead of a copied constant.
  assert.match(native, /fn primitive_limit/); assert.match(nativePackages, /primitive_limit\("field", "text"\)/);
  assert.match(nativePackages, /Some\("text" \| "textarea"\)/);
});

test('extensions primitives: every host advertises only declared primitives; native menus degrade instead of assuming', () => {
  const declared = new Set(Object.entries(PRIMITIVES.families).flatMap(([family, { kinds }]) => kinds.map(kind => `${family}.${kind}`)));
  assert.deepEqual(Object.keys(PRIMITIVES.hosts).sort(), ['actionSlot', 'dialog', 'inspectorView', 'nativeMenu', 'settings']);
  for (const [name, host] of Object.entries(PRIMITIVES.hosts)) {
    for (const id of [...host.accepts, ...host.omits, ...host.disables, ...Object.keys(host.degrades), ...Object.values(host.degrades)]) assert.ok(declared.has(id), `${name}: ${id}`);
    for (const id of [...host.omits, ...host.disables]) assert.ok(!host.accepts.includes(id), `${name}: ${id}`);
    for (const [from, to] of Object.entries(host.degrades)) { assert.ok(!host.accepts.includes(from)); assert.ok(host.accepts.includes(to), `${name}: ${from} -> ${to}`); }
  }
  for (const host of ['dialog', 'settings']) assert.deepEqual(PRIMITIVES.hosts[host].accepts, PRIMITIVES.families.field.kinds.map(kind => `field.${kind}`));
  assert.deepEqual(PRIMITIVES.hosts.settings.rejects, ['async']);
  assert.deepEqual(PRIMITIVES.hosts.nativeMenu.degrades, { 'menu.checkbox': 'menu.command', 'menu.radio': 'menu.command' });
  assert.deepEqual(PRIMITIVES.hosts.nativeMenu.omits, ['action.status', 'action.badge']);
  // Every command kind is either presented natively or shown as an unavailable (disabled) native entry.
  assert.deepEqual([...PRIMITIVES.hosts.nativeMenu.accepts, ...PRIMITIVES.hosts.nativeMenu.disables].filter(id => id.startsWith('command.')).sort(), PRIMITIVES.families.command.kinds.map(kind => `command.${kind}`).sort());
  for (const kind of PRIMITIVES.families.view.kinds) assert.ok(PRIMITIVES.hosts.inspectorView.accepts.includes(`view.${kind}`));
  for (const kind of PRIMITIVES.families.menu.kinds) assert.ok(PRIMITIVES.hosts.actionSlot.accepts.includes(`menu.${kind}`));
  for (const policy of ['accessible-name', 'ime-guard', 'escape-one-level', 'focus-restore', 'forced-colors', 'increase-contrast', 'reduced-motion', 'reduced-transparency']) assert.ok(PRIMITIVES.accessibility.includes(policy), policy);
  // Q059 (R0301, retained): `markup` stays excluded from host-rendered primitives because they render into the app's own
  // document (fault isolation, interface stability, ADR-0005). The permissioned HTML path is `view.rich` under
  // `ui.richViews`, mounted in its own frame or webview (tests/extensions-runtime-rich-mount.spec.ts).
  for (const excluded of ['callbacks', 'markup', 'dom-handles', 'raw-ipc']) assert.ok(PRIMITIVES.excluded.includes(excluded));
});

test('extensions primitives: the installable conformance package exercises every declarative primitive kind', () => {
  const checked = validateContract('packages', [manifest]);
  assert.equal(checked.ok, true, JSON.stringify(checked.error)); assert.deepEqual(checked.diagnostics, []);
  const contributes = manifest.contributes;
  const walk = items => items.flatMap(item => [item.kind, ...walk(item.items ?? [])]);
  const used = {
    action: contributes.menus.map(menu => menu.presentation ?? 'icon'),
    menu: walk(contributes.menus.flatMap(menu => menu.items ?? [])),
    command: contributes.commands.map(command => command.action.kind),
    field: [...dialog.fields, ...contributes.settings.flatMap(page => page.fields)].map(field => field.kind),
    view: contributes.views.flatMap(view => view.controls.map(control => control.kind)),
  };
  for (const [family, kinds] of Object.entries(used)) {
    // runCommand and showProjectContext need executable trust or a project grant and keep their own suites.
    const expected = PRIMITIVES.families[family].kinds.filter(kind => !['runCommand', 'showProjectContext'].includes(kind));
    assert.deepEqual([...new Set(kinds)].sort(), [...expected].sort(), family);
  }
  assert.ok(contributes.icons.every(icon => icon.asset.endsWith('.svg')) && contributes.menus[0].icon);
  // Declarative activation copies the same textarea data the native broker presents.
  const activation = createDeclarativeActivation({ safeMode: false, diagnostics: [], packages: [{ manifest, enabled: true, icons: {} }] }, 1);
  assert.deepEqual(activation.actionFor('sample.primitives/open-form', context), contributes.commands[0].action);
  assert.equal(activation.actionFor('sample.primitives/show-details', context).kind, 'showMessage');
  activation.dispose();
  const row = ledger.primitivesCoverage?.['panda.primitives'];
  assert.ok(row, 'surfaces ledger maps the primitive family');
  assert.deepEqual(row.families, Object.fromEntries(Object.entries(PRIMITIVES.families).map(([family, { kinds }]) => [family, kinds])));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-primitives-coverage\.spec\.ts/);
});

test('extensions primitives: malformed, prototype, oversize, unsupported, callback and ungranted data fail safely', () => {
  const field = mutate => packageWith(value => mutate(value.contributes.commands[0].action.dialog.fields[1]));
  const cases = {
    rowsLow: field(f => { f.rows = 1; }), rowsHigh: field(f => { f.rows = 13; }), rowsFraction: field(f => { f.rows = 2.5; }),
    oversize: field(f => { f.value = 'a'.repeat(4097); }), minimum: field(f => { f.minLength = 4097; }), number: field(f => { f.value = 3; }),
    unknownKind: field(f => { f.kind = 'richtext'; }), html: field(f => { f.kind = 'html'; f.html = '<b>x</b>'; }),
    callback: field(f => { f.onInput = 'fetch()'; }), placeholderOnTextarea: field(f => { f.options = []; }),
    prototype: packageWith(value => { value.contributes.commands[0].action.dialog.fields[1] = JSON.parse('{"id":"notes","kind":"textarea","label":"Notes","__proto__":{"polluted":true}}'); }),
    viewKind: packageWith(value => { value.contributes.views[0].controls.push({ kind: 'chart', label: 'Chart', items: [] }); }),
    viewMarkup: packageWith(value => { value.contributes.views[0].controls[0].html = '<script></script>'; }),
    actionKind: packageWith(value => { value.contributes.commands[1].action = { kind: 'eval', message: 'x' }; }),
    presentation: packageWith(value => { value.contributes.menus[1].presentation = 'select'; }),
    menuKind: packageWith(value => { value.contributes.menus[0].items[1].kind = 'textarea'; }),
    menuDepth: packageWith(value => {
      let items = [{ id: 'sample.primitives/deep-leaf', kind: 'command', title: 'Leaf', command: 'sample.primitives/notify' }];
      for (let depth = 0; depth < 6; depth++) items = [{ id: `sample.primitives/deep-${depth}`, kind: 'submenu', title: 'Deep', items }];
      value.contributes.menus[0].items = items;
    }),
    fields: packageWith(value => { value.contributes.commands[0].action.dialog.fields = Array.from({ length: 25 }, (_, n) => ({ id: `field-${n}`, kind: 'textarea', label: 'Notes' })); }),
    duplicateField: field(f => { f.id = 'name'; }),
    settingsAsync: packageWith(value => { value.contributes.settings[0].fields.push({ id: 'remote', kind: 'select', label: 'Remote', async: true, options: [] }); }),
    ungranted: packageWith(value => { value.permissions = []; }),
    reserved: packageWith(value => { value.contributes.menus[0].items[1].id = 'panda.primitives/send'; }),
    badgeLength: packageWith(value => { value.contributes.menus[2].badge = 'x'.repeat(17); }),
  };
  for (const [name, result] of Object.entries(cases)) {
    assert.equal(result.ok, false, name);
    if (name !== 'duplicateField') assert.notEqual(result.error.code, 'DuplicateId', name);
  }
  // A field variant mismatch inside `anyOf` is one stable shape error, whatever the inner limit.
  for (const name of ['rowsLow', 'rowsHigh', 'rowsFraction', 'oversize', 'unknownKind', 'callback', 'prototype', 'viewKind', 'actionKind', 'presentation']) assert.equal(cases[name].error.code, 'InvalidShape', name);
  assert.equal(cases.fields.error.code, 'InvalidShape'); assert.equal(cases.ungranted.error.code, 'PermissionDenied');
  assert.equal(validateContract('dialog', { ...dialog, fields: Array.from({ length: 25 }, (_, n) => ({ id: `field-${n}`, kind: 'textarea', label: 'Notes' })) }).error.code, 'LimitExceeded');
  assert.equal(validateContract('dialog', { ...dialog, fields: [{ ...dialog.fields[1], value: 'x'.repeat(300_000) }] }).error.code, 'LimitExceeded', 'byte budget');
  assert.equal(cases.settingsAsync.error.code, 'UnsupportedContribution'); assert.equal(cases.duplicateField.error.code, 'DuplicateId');
  assert.equal(cases.reserved.error.code, 'ReservedId'); assert.equal(cases.menuDepth.error.code, 'LimitExceeded');
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.polluted, undefined);
  // Host objects, accessors and functions are never read as data.
  const hostile = structuredClone(dialog); Object.defineProperty(hostile.fields[1], 'value', { get() { throw new Error('read'); }, enumerable: true });
  assert.equal(validateContract('dialog', hostile).ok, false);
  assert.equal(validateContract('dialog', { ...dialog, fields: [{ ...dialog.fields[1], value: () => 'x' }] }).ok, false);
  // Prior data contracts and examples stay valid unchanged.
  for (const name of ['menu-laboratory', 'view-laboratory', 'data-panel', 'settings-laboratory', 'sample-project-helper', 'core-dialogs', 'owned-dialogs']) {
    const prior = read(`./fixtures/extensions/${name}/extension.json`);
    assert.equal(validateContract('packages', [prior]).ok, true, name);
  }
});

test('extensions primitives: textarea form state keeps line breaks, validates locally and settles once after disposal', async () => {
  const calls = [];
  const callbacks = {
    async options(field, query, captured, signal) { calls.push({ kind: 'options', query, signal }); await new Promise(resolve => setTimeout(resolve, 5)); return field.options; },
    async validate(values, captured, signal) { calls.push({ kind: 'validate', values, signal }); return {}; },
  };
  const state = createDialogState(dialog, context, callbacks);
  assert.deepEqual(state.values(), { name: '', notes: '', enabled: true, format: '', tags: [] });
  assert.deepEqual(Object.keys(await state.validate()).sort(), ['format', 'name', 'notes']);
  state.set('name', 'Report'); state.set('format', 'full'); state.set('notes', 'ab');
  assert.deepEqual(await state.validate(), { notes: 'Enter at least 3 characters.' });
  state.set('notes', 'First line\nSecond line');
  assert.deepEqual(await state.validate(), {});
  assert.equal(calls.at(-1).values.notes, 'First line\nSecond line');
  for (const invalid of [3, true, ['x'], 'a'.repeat(TEXT_LIMIT + 1)]) assert.throws(() => state.set('notes', invalid), /Invalid field value/);
  assert.throws(() => state.set('format', 'archived'), /Invalid field value/, 'disabled options cannot be chosen');
  const pending = state.options('tags', 'a'.repeat(500));
  assert.equal(calls.at(-1).query.length, primitiveLimit('field', 'query'));
  state.dispose();
  assert.equal(calls.at(-1).signal.aborted, true);
  assert.equal(await pending, undefined, 'late replies after disposal are ignored');
  state.set('notes', 'ignored after disposal');
  assert.equal(await state.validate(), undefined);
  assert.equal(state.values().notes, 'First line\nSecond line');
});

test('extensions primitives: settings pages accept textarea values with the same bounded contract', () => {
  const page = manifest.contributes.settings[0];
  assert.deepEqual(settingsDefaults(page), { summary: 'First line', active: false });
  assert.equal(validSettingsValues(page, { summary: 'One\nTwo', active: true }), true);
  for (const invalid of [{ summary: 'x'.repeat(4097), active: true }, { summary: 4, active: true }, { summary: 'ok' }, { summary: 'ok', active: true, extra: 1 }]) assert.equal(validSettingsValues(page, invalid), false);
  const required = { ...page, fields: [{ id: 'summary', kind: 'textarea', label: 'Summary', required: true, minLength: 3 }] };
  assert.equal(validSettingsValues(required, { summary: '  ' }), false); assert.equal(validSettingsValues(required, { summary: 'abc' }), true);
});
