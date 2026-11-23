import test from 'node:test';
import assert from 'node:assert/strict';
import { advertisedModelsOnly } from '../src/model-catalog.ts';
import { approvalMode, approvalModes } from '../src/approval-modes.ts';

test('advertisedModelsOnly restricts Antigravity along with GitHub Copilot and Devin', () => {
  assert.equal(advertisedModelsOnly('antigravity'), true);
  assert.equal(advertisedModelsOnly('github-copilot'), true);
  assert.equal(advertisedModelsOnly('devin'), true);
  assert.equal(advertisedModelsOnly('claude'), false);
  assert.equal(advertisedModelsOnly('codex'), false);
});

test('approvalModes describes Antigravity native ACP modes instead of generic fallbacks', () => {
  const modes = approvalModes('antigravity');
  assert.deepEqual(modes.map(mode => mode.id), ['ask', 'auto', 'plan', 'full']);

  const byId = new Map(modes.map(mode => [mode.id, mode]));
  assert.match(byId.get('ask').description, /Antigravity’s Default mode/i);
  assert.doesNotMatch(byId.get('ask').description, /harness’s normal rules/i);

  assert.match(byId.get('auto').description, /Antigravity’s Accept edits mode/i);
  assert.doesNotMatch(byId.get('auto').description, /offered by the server/i);

  assert.match(byId.get('plan').description, /Antigravity’s Plan mode/i);
  assert.doesNotMatch(byId.get('plan').description, /Explore and plan changes before implementation/i);

  assert.match(byId.get('full').description, /Antigravity’s Auto mode/i);
  assert.match(byId.get('full').description, /every permission request approved/i);
  assert.doesNotMatch(byId.get('full').description, /--dangerously-skip-permissions/);
  assert.match(byId.get('full').description, /Server restrictions still apply/i);

  for (const id of ['ask', 'auto', 'plan', 'full']) {
    assert.deepEqual(approvalMode('antigravity', id), byId.get(id));
  }
});
