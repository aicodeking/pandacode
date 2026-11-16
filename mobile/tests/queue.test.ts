/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canRestore, editorState, placedAt, readdedId, removalUndo, sendAllowed } from '../src/store/queue-order.ts';

test('Undo is offered only for a removal the phone knows in full', () => {
  assert.equal(canRestore({ truncated: false, attachments: 0 }), true);
  assert.equal(canRestore({ truncated: true, attachments: 0 }), false);
  assert.equal(canRestore({ truncated: false, attachments: 2 }), false);
});

test('with queue.restore every removal gets Undo; without it some ask first', () => {
  const plain = { truncated: false, attachments: 0 };
  const long = { truncated: true, attachments: 0 };
  const attached = { truncated: false, attachments: 1 };
  for (const entry of [plain, long, attached]) assert.equal(removalUndo(entry, { restore: true, sendAllowed: false }), 'undo');
  assert.equal(removalUndo(plain, { restore: false, sendAllowed: true }), 'undo');
  assert.equal(removalUndo(long, { restore: false, sendAllowed: true }), 'confirm');
  assert.equal(removalUndo(attached, { restore: false, sendAllowed: true }), 'confirm');
  assert.equal(removalUndo(plain, { restore: false, sendAllowed: false }), 'confirm', 'task.send would be refused');
});

test('an older host refuses a full-mode send only with its Full access switch off', () => {
  assert.equal(sendAllowed('full', false), false);
  assert.equal(sendAllowed('full', true), true);
  assert.equal(sendAllowed('full', undefined), true);
  assert.equal(sendAllowed('ask', false), true);
});

test('the re-added entry is the new one with the same text', () => {
  const after = [{ id: 'a', text: 'one' }, { id: 'c', text: 'three' }, { id: 'n', text: 'two' }];
  assert.equal(readdedId(['a', 'c'], after, 'two'), 'n');
  // Same text as an entry already there: the new id, not the old one.
  assert.equal(readdedId(['a', 'c'], [...after, { id: 'm', text: 'one' }], 'one'), 'm');
  assert.equal(readdedId(['a', 'c'], after, 'missing'), null);
});

test('Undo puts the message back at its old place', () => {
  // b was second; re-added at the end, it moves back to index 1.
  assert.deepEqual(placedAt(['a', 'c', 'd', 'b'], 'b', 1), ['a', 'b', 'c', 'd']);
  assert.deepEqual(placedAt(['a', 'b'], 'b', 0), ['b', 'a']);
  // The queue shrank meanwhile (the run took the front): clamp to the end.
  assert.deepEqual(placedAt(['c', 'b'], 'b', 5), ['c', 'b']);
  // An id not there leaves the order unchanged.
  assert.deepEqual(placedAt(['a', 'c'], 'z', 0), ['a', 'c']);
});

test('the Queue screen removes on the computer at once and offers Undo in a toast', async () => {
  const { readFileSync } = await import('node:fs');
  const screen = readFileSync(new URL('../src/app/queue.tsx', import.meta.url), 'utf8');
  assert.match(screen, /await removeQueued\(device, session, entry\.id\)/);
  assert.match(screen, /showToast\(\{[^}]*title: 'Removed from the queue'/);
  assert.match(screen, /hostRestores \? restoreRemoved\(device, session, entry\.id\) : restoreQueued\(device, session, entry, before\)/);
  assert.match(screen, /useHostSupports\(device, 'queue\.restore'\)/);
  assert.match(screen, /<HeaderActions \/>/);
  assert.doesNotMatch(screen, /setTimeout\(commit/);
  assert.doesNotMatch(screen, /<Banner visible=\{!!removed\}/);
});

test('the older-host re-add sends once under a sendId', async () => {
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../src/connect/api/queue.ts', import.meta.url), 'utf8');
  assert.match(api, /runOnce\(sendId => hostCall<\{ queued\?: boolean \}>\(deviceId, 'task\.send', \{ sessionId, text: entry\.text, \.\.\.\(sendId && \{ sendId \}\) \}\), dedupes\)/);
});

test('the editor stays open while its message is queued and says it was sent once it leaves', () => {
  const queue = [{ id: 'a' }, { id: 'b' }];
  assert.equal(editorState(null, queue), 'none');
  assert.equal(editorState('a', queue), 'open');
  assert.equal(editorState('a', undefined), 'open', 'not loaded yet: nothing known');
  assert.equal(editorState('c', queue), 'sent');
  assert.equal(editorState('a', []), 'sent', 'the computer sent the last message');
});

test('two quick removals keep both rows hidden, and swiping is off while a change is on the way', async () => {
  const { readFileSync } = await import('node:fs');
  const screen = readFileSync(new URL('../src/app/queue.tsx', import.meta.url), 'utf8');
  // An immutable set of ids: each removal adds its own and the finish drops only its own.
  assert.match(screen, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/);
  assert.match(screen, /setRemoving\(ids => new Set\(\[\.\.\.ids, entry\.id\]\)\)/);
  assert.match(screen, /setRemoving\(ids => new Set\(\[\.\.\.ids\]\.filter\(id => id !== entry\.id\)\)\)/);
  assert.match(screen, /filter\(e => !removing\.has\(e\.id\)\)/);
  assert.doesNotMatch(screen, /setRemoving\(null\)/);
  assert.match(screen, /<Swipeable enabled=\{rights\.remove && !busy\}/);
  // A changed draft asks before the screen goes.
  assert.match(screen, /useDiscardGuard\(text !== entry\.text/);
});

test('the Queue and Review styles use ds tokens, not literal spacing', async () => {
  const { readFileSync } = await import('node:fs');
  const SPACING = /\b(gap|padding\w*|margin\w*): [1-9]/;
  for (const file of ['queue.tsx', 'pull.tsx']) {
    const source = readFileSync(new URL(`../src/app/${file}`, import.meta.url), 'utf8');
    const styles = source.slice(source.lastIndexOf('StyleSheet.create('));
    const lines = styles.split('\n').filter(line => file === 'queue.tsx' || /^\s+review/.test(line));
    for (const line of lines) assert.doesNotMatch(line, SPACING, `${file}: ${line.trim()}`);
  }
});

test('a queue.remove whose reply was lost reloads the queue and still offers Undo if the entry is gone', () => {
  const screen = readFileSync(new URL('../src/app/queue.tsx', import.meta.url), 'utf8');
  const landed = screen.match(/async function removalLanded\([^]*?\n\}/)?.[0];
  assert.ok(landed, 'removalLanded not found');
  assert.match(landed, /if \(!promptMaybeRan\(error\)\) return false;/);
  assert.match(landed, /await loadQueue\(device, session\)/);
  assert.match(landed, /!entries\.some\(e => e\.id === id\)/);
  // A landed removal falls through to the Undo toast; any other error still throws to run()'s alert.
  assert.match(screen, /catch \(e\) \{\n\s+if \(!\(await removalLanded\(device, session, entry\.id, e\)\)\) throw e;/);
});
