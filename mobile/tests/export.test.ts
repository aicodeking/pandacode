/// <reference types="node" />
// The pure parts of Export (store/thread-model.ts): the Android share cap, the truncation mark and the
// shared file's name. TaskHeader's exportAction writes a file on iOS and caps the text on Android.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ANDROID_SHARE_CAP, capExport, EXPORT_CAP, exportFileName, isTruncatedExport, readPages, TRUNCATED_MARK, utf8Length } from '../src/store/thread-model.ts';

test('utf8Length counts UTF-8 bytes, surrogate pairs as four', () => {
  assert.equal(utf8Length(''), 0);
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('é'), 2);
  assert.equal(utf8Length('€'), 3);
  assert.equal(utf8Length('🐼'), 4);
  assert.equal(utf8Length('a🐼é'), Buffer.byteLength('a🐼é', 'utf8'));
});

test('the Android cap stays well under the ~1 MB binder limit, and below the paging cap', () => {
  assert.ok(ANDROID_SHARE_CAP <= 500 * 1024);
  assert.ok(ANDROID_SHARE_CAP < EXPORT_CAP);
});

test('capExport leaves short text alone and reports a truncation already in it', () => {
  assert.deepEqual(capExport('# Task\n\nhello', 1000), { text: '# Task\n\nhello', truncated: false });
  assert.deepEqual(capExport(`hello${TRUNCATED_MARK}`, 1000), { text: `hello${TRUNCATED_MARK}`, truncated: true });
});

test('capExport cuts long text within the cap, on a character boundary, with one mark', () => {
  const text = '🐼é'.repeat(50_000);
  const capped = capExport(text, 1000);
  assert.equal(capped.truncated, true);
  assert.ok(isTruncatedExport(capped.text));
  assert.ok(utf8Length(capped.text) <= 1000);
  assert.ok(utf8Length(capped.text) > 990, 'uses the budget');
  const body = capped.text.slice(0, -TRUNCATED_MARK.length);
  assert.ok(text.startsWith(body));
  assert.ok(!/[\ud800-\udbff]$/.test(body), 'no lone high surrogate at the cut');
  // Already marked by paging: still one mark.
  const again = capExport(`${'x'.repeat(5000)}${TRUNCATED_MARK}`, 100);
  assert.equal(again.text.split('[Truncated]').length, 2);
  assert.ok(utf8Length(again.text) <= 100);
});

test('readPages marks a capped export the way isTruncatedExport reads it', async () => {
  const pages = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];
  const result = await readPages(async offset => ({ text: pages[offset], next: offset + 1 < pages.length ? offset + 1 : null }), 15);
  assert.equal(result.truncated, true);
  assert.ok(isTruncatedExport(result.text));
  const whole = await readPages(async offset => ({ text: pages[offset], next: offset + 1 < pages.length ? offset + 1 : null }));
  assert.equal(isTruncatedExport(whole.text), false);
});

test('exportFileName strips path and control characters and falls back to Task', () => {
  assert.equal(exportFileName('Fix the build'), 'Fix the build.md');
  assert.equal(exportFileName('a/b\\c:d*e?"f"<g>|h'), 'a b c d e f g h.md');
  assert.equal(exportFileName('../../etc/passwd'), 'etc passwd.md');
  assert.equal(exportFileName('line\nbreak\u0000'), 'line break.md');
  assert.equal(exportFileName('   '), 'Task.md');
  assert.equal(exportFileName('...'), 'Task.md');
  assert.ok(exportFileName('x'.repeat(500)).length <= 83);
});
