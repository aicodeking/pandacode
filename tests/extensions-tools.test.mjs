import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { SIMULATOR_CONTROLS, VM_CONTROLS, DESIGN_CONTROLS, BTW_CONTROLS } from '../src/extensions/surfaces.ts';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const controls = { 'panda.simulator': SIMULATOR_CONTROLS, 'panda.vm': VM_CONTROLS, 'panda.design': DESIGN_CONTROLS, 'panda.btw': BTW_CONTROLS };

test('tools audit maps every discovered source/inspector member and exact public control without waiving original T54 criteria', () => {
  const audit = ledger.toolsAudit;
  assert.deepEqual(Object.keys(audit.criteria).sort(), ['C1', 'C2', 'C3']);
  assert.equal(audit.families.length, 4);
  const discovered = ledger.sourceInventory.flatMap(([source, actions]) => {
    if (!['src/simulator.ts', 'src/vm-panel.ts', 'src/btw-panel.ts'].includes(source)) return [];
    return actions.map(action => `panda.inventory.${source.split('/').at(-1).replace('.ts', '')}.${action}`);
  });
  const mapped = audit.families.flatMap(f => f.ids);
  for (const id of discovered) assert.ok(mapped.includes(id), id);
  for (const family of audit.families) {
    assert.ok(mapped.includes(`panda.inspector.${family.slot.split('.')[1]}`));
    assert.deepEqual([...family.members].sort(), Object.values(controls[family.slot]).flatMap(items => items.map(([id]) => id)).sort());
    for (const key of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'exceptions']) assert.ok(family[key]?.length > 20, `${family.slot}.${key}`);
    for (const path of family.evidence) assert.ok(read(`../${path}`).length);
    assert.ok(ledger[family.details]);
  }
});

test('four tool packages compose through shared public manifests and the integrated suite is registered in both engines and CI', () => {
  const manifests = ['simulator', 'vm', 'design', 'btw'].map(name => JSON.parse(read(`./fixtures/extensions/${name}/extension.json`)));
  assert.equal(validateContract('packages', manifests).ok, true);
  for (const manifest of manifests) {
    assert.equal(manifest.extensionKind, 'ui');
    assert.equal(manifest.main, undefined);
    assert.equal(manifest.contributes.components[0].contractVersion, 1);
    assert.doesNotMatch(JSON.stringify(manifest), /(?:src\/|querySelector|data-action|tauri|<script)/i);
  }
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-tools-coverage\.spec\.ts/);
  assert.match(read('../playwright.webkit.config.ts'), /\|extensions tools/);
});
