/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { statusTally } from '../src/ui/file-groups.ts';

test('the tally counts each status in a fixed order and skips the rest', () => {
  assert.equal(statusTally(['M', 'A', 'M', undefined]), '1 added · 2 modified');
  assert.equal(statusTally(['U']), '1 conflicted');
  assert.equal(statusTally([]), '');
});
