import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Settings → Agents lists one explorer switch per harness in `EXPLORE_HARNESSES`, which mirrors
// `explore_name` by hand; the native switch refuses any harness outside it.
const SETTINGS = 'src/settings.ts';
const PERMISSIONS = 'src-tauri/src/providers/explore_permissions.rs';

function settingsHarnesses() {
  const source = readFileSync(SETTINGS, 'utf8');
  const block = source.match(/const EXPLORE_HARNESSES\b[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, `EXPLORE_HARNESSES not found in ${SETTINGS}`);
  return [...block[1].matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
}

function nativeHarnesses() {
  const source = readFileSync(PERMISSIONS, 'utf8');
  const body = source.match(/fn explore_name\(provider: &str\)[^{]*\{\s*match provider \{([\s\S]*?)\n\s*\}\n\}/);
  assert.ok(body, `explore_name not found in ${PERMISSIONS}`);
  const ids = [];
  for (const line of body[1].split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    const arm = code.match(/^\s*([^=]*?)\s*=>/);
    if (!arm || arm[1] === '_') continue;
    ids.push(...[...arm[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  }
  return ids;
}

const unique = (list) => new Set(list).size === list.length;

test('EXPLORE_HARNESSES and explore_name list no duplicates', () => {
  const ui = settingsHarnesses();
  const native = nativeHarnesses();
  assert.ok(ui.length > 0, 'no ids parsed from EXPLORE_HARNESSES');
  assert.ok(native.length > 0, 'no provider literals parsed from explore_name');
  assert.ok(unique(ui), `duplicate ids in EXPLORE_HARNESSES: ${ui}`);
  assert.ok(unique(native), `duplicate providers in explore_name: ${native}`);
});

test('EXPLORE_HARNESSES matches the harnesses explore_name serves', () => {
  const ui = [...settingsHarnesses()].sort();
  const native = [...nativeHarnesses()].sort();
  assert.deepEqual(ui, native);
});

test('Claude Code leads EXPLORE_HARNESSES and is served natively', () => {
  assert.equal(settingsHarnesses()[0], 'claude');
  assert.ok(nativeHarnesses().includes('claude'));
});
