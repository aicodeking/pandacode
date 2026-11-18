/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { demoChanges, demoDiff } from '../src/demo-pull.ts';

test('each demo task shows its own branch, files and diffs', () => {
  assert.equal(demoChanges('flaky', 'fix/upload-retry').branch, 'fix/upload-retry');
  assert.ok(demoChanges('flaky', 'x').files.some(f => f.path === 'relay/src/upload.ts'));
  assert.ok(!demoChanges('flaky', 'x').files.some(f => f.path === 'package.json'));
  assert.equal(demoChanges('new', undefined).branch, 'main');
  for (const session of ['auth', 'team', 'flaky', 'docs', 'readme']) {
    for (const file of demoChanges(session, 'b').files) assert.match(demoDiff(session, file.path), new RegExp(`^diff --git a/${file.path} `));
  }
});
