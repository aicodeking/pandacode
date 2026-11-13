/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPage, assembleData, canEdit, draftProblem, EDIT_LIMIT, isDirty, isWriteConflict, savedText, startEdit, bytesLabel, commentPrefix, crumbs, fileIcon, folderTitle, highlight, matchCount, parentOf, splitLines, tokenize, utf8Length, type DataPage } from '../src/store/files.ts';
import { CHAR_WIDTH, codeWidth, expandTabs, GUTTER_PAD, gutterWidth, MAX_CHARS, TAB_SIZE } from '../src/ui/hub/code-lines.ts';
import { DEMO_FILES, demoHash, demoListing, handlers, resetDemoEdits } from '../src/demo/files.ts';

const page = (data: string, offset: number, total: number, done: boolean, mime = 'image/png'): DataPage => ({ mime, data, offset, total, done });

test('a paged image assembles into one data URL', async () => {
  const pages = [page('QUJD', 0, 8, false), page('REVG', 4, 8, true)];
  const asked: number[] = [];
  const url = await assembleData(async offset => { asked.push(offset); return pages[asked.length - 1]; });
  assert.equal(url, 'data:image/png;base64,QUJDREVG');
  assert.deepEqual(asked, [0, 4]);
});

test('a paged image refuses replies that do not add up', async () => {
  await assert.rejects(assembleData(async () => page('QUJD', 4, 4, true)), /Invalid image reply/);
  await assert.rejects(assembleData(async () => page('', 0, 8, false)), /no progress/);
  await assert.rejects(assembleData(async () => page('QUJD', 0, 8, true)), /length/);
  await assert.rejects(assembleData(async () => page('QUJD', 0, 4, true, 'text/html')), /Invalid image reply/);
  let n = 0;
  await assert.rejects(assembleData(async offset => (n++ ? page('REVG', offset, 8, true, 'image/gif') : page('QUJD', 0, 8, false))), /changed/);
});

test('text pages append by byte offset', () => {
  const first = appendPage(null, { kind: 'text', path: 'a', text: 'héllo\n', offset: 0, total: 12, done: false });
  assert.equal(first.bytes, 7);
  const both = appendPage(first, { kind: 'text', path: 'a', text: 'world\n', offset: 7, total: 13, done: true });
  assert.equal(both.text, 'héllo\nworld\n');
  assert.equal(both.done, true);
  assert.throws(() => appendPage(first, { kind: 'text', path: 'a', text: 'x', offset: 6, total: 13, done: true }), /changed/);
  assert.equal(utf8Length('a€😀'), 1 + 3 + 4);
});

test('paths, crumbs and titles', () => {
  assert.deepEqual(crumbs('src/ui/hub', 'app'), [{ name: 'app', path: '' }, { name: 'src', path: 'src' }, { name: 'ui', path: 'src/ui' }, { name: 'hub', path: 'src/ui/hub' }]);
  assert.deepEqual(crumbs('', 'app'), [{ name: 'app', path: '' }]);
  assert.equal(parentOf('src/a.ts'), 'src');
  assert.equal(parentOf('a.ts'), '');
  assert.equal(folderTitle('', 'app'), 'app');
  assert.equal(folderTitle('src/ui', 'app'), 'ui');
  assert.equal(fileIcon('src', true).ios, 'folder');
  assert.equal(fileIcon('logo.PNG', false).ios, 'photo');
  assert.equal(fileIcon('Makefile', false).ios, 'doc');
  assert.equal(bytesLabel(900), '900 B');
  assert.equal(bytesLabel(2048), '2 KB');
});

test('lines split without a phantom last line', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), ['']);
});

test('the light colouring finds comments, strings, keywords and numbers', () => {
  const tokens = tokenize('const url = "http://x"; // the // inside a string is not a comment', '//');
  assert.deepEqual(tokens.map(t => t.kind), ['keyword', 'plain', 'string', 'plain', 'comment']);
  assert.equal(tokens.map(t => t.text).join(''), 'const url = "http://x"; // the // inside a string is not a comment');
  assert.deepEqual(tokenize('x = 42  # note', '#').map(t => t.kind), ['plain', 'number', 'plain', 'comment']);
  assert.equal(tokenize('x'.repeat(500), '//').length, 1);
  assert.equal(commentPrefix('main.py'), '#');
  assert.equal(commentPrefix('lib.rs'), '//');
  assert.equal(commentPrefix('README.md'), null);
});

test('match highlights split the line around each range', () => {
  assert.deepEqual(highlight('let todo = 1; // todo', [[4, 8], [17, 21]]), [
    { text: 'let ', hit: false }, { text: 'todo', hit: true }, { text: ' = 1; // ', hit: false }, { text: 'todo', hit: true },
  ]);
  assert.deepEqual(highlight('abc', [[5, 9]]), [{ text: 'abc', hit: false }]);
  assert.equal(matchCount([{ path: 'a', matches: [{ line: 1, text: '', ranges: [] }] }, { path: 'b', matches: [] }]), 1);
});

test('the demo checkout lists folders first and answers the files methods', () => {
  const root = demoListing('');
  assert.equal(root[0].dir, true);
  assert.ok(root.some(e => e.name === 'README.md' && !e.dir));
  assert.ok(demoListing('src').every(e => e.path.startsWith('src/')));
  const state = { tasks: { studio: { tasks: [{ sessionId: 's1', projectId: 'web' }], projects: [{ id: 'web', name: 'web', repo: null }] } } };
  const ctx = { host: {} as never, deviceId: 'studio', state: state as never, reply: () => undefined };
  const read = handlers['files.read'](ctx, { projectId: 'web', path: 'README.md' }) as { kind: string; text: string; total: number };
  assert.equal(read.kind, 'text');
  assert.match(read.text, /^# web/);
  assert.equal(read.total, utf8Length(read.text));
  assert.equal((handlers['files.read'](ctx, { sessionId: 's1', path: 'assets/logo.svg' }) as { kind: string }).kind, 'image');
  const grep = handlers['files.grep'](ctx, { projectId: 'web', query: 'TODO' }) as { files: { path: string }[] };
  assert.deepEqual(grep.files.map(f => f.path), ['src/upload.ts']);
  assert.throws(() => handlers['files.list'](ctx, {}), /project/);
  assert.ok(Object.keys(DEMO_FILES).length > 5);
});

test('pages of one file share a version; a page of another version is refused', () => {
  const first = appendPage(null, { kind: 'text', path: 'a', text: 'one\n', offset: 0, total: 8, done: false, hash: 'h1' });
  assert.equal(first.hash, 'h1');
  assert.equal(appendPage(first, { kind: 'text', path: 'a', text: 'two\n', offset: 4, total: 8, done: true, hash: 'h1' }).hash, 'h1');
  assert.throws(() => appendPage(first, { kind: 'text', path: 'a', text: 'two\n', offset: 4, total: 8, done: true, hash: 'h2' }), /changed/);
});

test('only whole, versioned, small text is editable', () => {
  const loaded = { text: 'a', bytes: 1, total: 1, done: true, hash: 'h' };
  assert.equal(canEdit(loaded), true);
  assert.equal(canEdit(null), false);
  assert.equal(canEdit({ ...loaded, done: false }), false);
  assert.equal(canEdit({ ...loaded, hash: undefined }), false, 'an older host sends no version');
  assert.equal(canEdit({ ...loaded, total: EDIT_LIMIT + 1 }), false);
  assert.equal(draftProblem('fine'), null);
  assert.match(draftProblem('a\0b') ?? '', /text/);
  assert.match(draftProblem('€'.repeat(EDIT_LIMIT / 3 + 1)) ?? '', /at most/);
});

test('an edit is dirty once its draft differs, and a save becomes the loaded text', () => {
  const edit = startEdit({ text: 'x\n', bytes: 2, total: 2, done: true, hash: 'h' });
  assert.equal(isDirty(edit), false);
  assert.ok(edit.mode === 'edit');
  assert.equal(isDirty({ ...edit, draft: 'y\n' }), true);
  assert.equal(isDirty({ mode: 'view' }), false);
  assert.equal(edit.base, 'h');
  assert.deepEqual(savedText('é', 'h2'), { text: 'é', bytes: 2, total: 2, done: true, hash: 'h2' });
  assert.equal(isWriteConflict(new Error('Changed on the computer since you opened it.')), true);
  assert.equal(isWriteConflict(new Error('Couldn’t save')), false);
  assert.equal(isWriteConflict('Changed on the computer'), false);
});

test('the demo saves an edit for the session and refuses a stale version', () => {
  resetDemoEdits();
  const state = { tasks: { studio: { tasks: [], projects: [{ id: 'web', name: 'web', repo: null }] } } };
  const ctx = { host: {} as never, deviceId: 'studio', state: state as never, reply: () => undefined };
  const read = () => handlers['files.read'](ctx, { projectId: 'web', path: 'README.md' }) as { text: string; hash: string };
  const before = read();
  assert.equal(before.hash, demoHash(before.text));
  assert.equal(before.hash.length, 64);
  const saved = handlers['files.write'](ctx, { projectId: 'web', path: 'README.md', text: '# edited\n', baseHash: before.hash }) as { hash: string };
  assert.equal(read().text, '# edited\n');
  assert.equal(read().hash, saved.hash);
  assert.throws(() => handlers['files.write'](ctx, { projectId: 'web', path: 'README.md', text: 'again', baseHash: before.hash }), (e: Error) => isWriteConflict(e));
  assert.throws(() => handlers['files.write'](ctx, { projectId: 'web', path: 'assets/logo.svg', text: 'x', baseHash: 'h' }), /text/);
  resetDemoEdits();
  assert.equal(read().text, before.text);
});

test('the code view expands tabs to the next stop before measuring', () => {
  assert.equal(TAB_SIZE, 4);
  assert.equal(expandTabs('no tabs'), 'no tabs');
  assert.equal(expandTabs('\tx'), '    x');
  assert.equal(expandTabs('ab\tc'), 'ab  c', 'to the next stop, not four more');
  assert.equal(expandTabs('abcd\te'), 'abcd    e');
  assert.equal(expandTabs('\t\t'), ' '.repeat(8));
  assert.equal(expandTabs('a\tb', 2), 'a b');
  assert.ok(!expandTabs('\ta\tbc\t').includes('\t'));
});

test('the code view width covers the gutter and the longest line, capped, at least the pane', () => {
  const gutter = gutterWidth(9);
  assert.equal(gutter, CHAR_WIDTH + GUTTER_PAD * 2);
  assert.equal(gutterWidth(0), gutter, 'an empty file still has one digit');
  assert.equal(gutterWidth(100), 3 * CHAR_WIDTH + GUTTER_PAD * 2);
  const lines = ['ab', expandTabs('\t\tx')];
  assert.equal(codeWidth(lines, 0), gutterWidth(2) + 9 * CHAR_WIDTH + GUTTER_PAD * 2, 'measured after expansion');
  assert.equal(codeWidth(lines, 5000), 5000, 'a short file fills the pane');
  assert.equal(codeWidth(['x'.repeat(MAX_CHARS + 50)], 0), gutterWidth(1) + MAX_CHARS * CHAR_WIDTH + GUTTER_PAD * 2);
});
