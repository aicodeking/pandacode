/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { legacy, parseHello } from '../src/connect/api/hello.ts';
import { accessNoteText } from '../src/ui/access-note.ts';

const hello = (extra: Record<string, unknown>) => parseHello({ protocol: 2, appVersion: '0.4.0', methods: ['git.commit', 'files.write', 'git.status'], ...extra })!;

test('no note while unknown, allowed, legacy or merely outdated', () => {
  assert.equal(accessNoteText(undefined, ['git.commit'], 'Mac'), null);
  assert.equal(accessNoteText(legacy(), ['git.commit'], 'Mac'), null);
  const full = hello({ access: 'full', methodAccess: { 'git.commit': 'control' }, features: ['remoteFullAccess'] });
  assert.equal(accessNoteText(full, ['git.commit', 'files.write', 'pull.create'], 'Mac'), null);
});

test('a narrow grant names the access it needs', () => {
  const view = hello({ access: 'view', methodAccess: { 'git.status': 'view', 'git.commit': 'control', 'files.write': 'full' } });
  assert.equal(accessNoteText(view, ['git.status', 'git.commit'], 'Mac'), 'Needs Control access — change it for this phone in PandaCode Settings → Connect on Mac.');
  assert.match(accessNoteText(view, ['files.write'], 'Mac') ?? '', /^Needs Full access/);
});

test('the Full access switch has its own note', () => {
  const full = hello({ access: 'full', methodAccess: { 'files.write': 'full' } });
  assert.equal(accessNoteText(full, ['git.commit', 'files.write'], 'Mac'), 'Turn on Full access for remote tasks on Mac.');
});
