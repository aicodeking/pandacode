/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileMention, insertMention, MAX_MENTIONS, mentionCache, MENTION_CACHE_MS, MENTION_CACHE_SIZE, mentionRows, mentionToken } from '../src/store/mentions.ts';

const at = (text: string) => mentionToken(text, text.length);

test('references match the desktop: plain paths bare, others quoted and escaped, folders with a slash', () => {
  assert.equal(fileMention('src/main.ts'), '@src/main.ts');
  assert.equal(fileMention('docs/design notes.md'), '@"docs/design notes.md"');
  assert.equal(fileMention('a"b.ts'), '@"a\\"b.ts"');
  assert.equal(fileMention('src/components', true), '@src/components/');
  assert.equal(fileMention('src/components/', true), '@src/components/');
  assert.equal(fileMention('über/ß.ts'), '@über/ß.ts');
});

test('an @ opens a mention only at the start, after a space or a bracket', () => {
  assert.deepEqual(at('@'), { start: 0, end: 1, query: '' });
  assert.deepEqual(at('look at @src/ma'), { start: 8, end: 15, query: 'src/ma' });
  assert.deepEqual(at('(@rea'), { start: 1, end: 5, query: 'rea' });
  assert.equal(at('mail me@example.com'), null, 'emails are text');
  assert.equal(at('npm i react@18'), null, 'package@version is text');
  assert.equal(at('@src/a.ts done'), null, 'the caret has left the mention');
});

test('a quoted mention is unescaped and spans through its closing quote', () => {
  assert.deepEqual(at('@"docs/des'), { start: 0, end: 10, query: 'docs/des' });
  assert.deepEqual(at('@“docs/a b'), { start: 0, end: 10, query: 'docs/a b' });
  const text = 'see @"docs/des" now';
  assert.deepEqual(mentionToken(text, 10), { start: 4, end: 15, query: 'docs' });
  assert.deepEqual(at('@"a\\"b'), { start: 0, end: 6, query: 'a"b' });
  assert.deepEqual(at('@"a\\u00'), { start: 0, end: 7, query: 'a\\u00' }, 'a half-typed escape still searches');
});

test('a bare mention ends at the next space, and a selection is never a mention', () => {
  assert.deepEqual(mentionToken('@src/ma.ts more', 4), { start: 0, end: 10, query: 'src' });
  assert.equal(mentionToken('@src', 1, 3), null);
  assert.equal(mentionToken('@src', 9), null);
  assert.equal(at(`@${'x'.repeat(257)}`), null, 'over-long queries are not searched');
});

test('insertion replaces the token and leaves one space after it', () => {
  const text = 'fix @sr';
  assert.deepEqual(insertMention(text, at(text)!, { path: 'src/main.ts', dir: false }), { text: 'fix @src/main.ts ', caret: 17 });
  const middle = 'fix @sr then';
  assert.deepEqual(insertMention(middle, mentionToken(middle, 7)!, { path: 'src/main.ts', dir: false }), { text: 'fix @src/main.ts then', caret: 17 });
  const quoted = 'read @"docs/de"';
  assert.deepEqual(insertMention(quoted, mentionToken(quoted, 14)!, { path: 'docs/design notes.md', dir: false }), { text: 'read @"docs/design notes.md" ', caret: 29 });
  assert.equal(insertMention('@co', at('@co')!, { path: 'src/components', dir: true }).text, '@src/components/ ');
});

test('search rows drop junk and repeats and are capped', () => {
  const rows = mentionRows([{ name: 'a.ts', path: 'a.ts', dir: false }, { path: 'a.ts' }, null, { path: '' }, { path: 7 }, { path: 'src/b', dir: true }]);
  assert.deepEqual(rows, [{ name: 'a.ts', path: 'a.ts', dir: false }, { name: 'b', path: 'src/b', dir: true }]);
  assert.equal(mentionRows(Array.from({ length: 90 }, (_, i) => ({ path: `f${i}` }))).length, MAX_MENTIONS);
});

test('the cache keeps recent queries briefly and is never changed in place', () => {
  const rows = [{ name: 'a', path: 'a', dir: false }];
  const empty = mentionCache();
  const one = empty.set('a', rows, 1000);
  assert.equal(empty.get('a', 1000), undefined);
  assert.deepEqual(one.get('a', 1000 + MENTION_CACHE_MS - 1), rows);
  assert.equal(one.get('a', 1000 + MENTION_CACHE_MS), undefined);
  let full = one;
  for (let i = 0; i < MENTION_CACHE_SIZE; i++) full = full.set(`q${i}`, rows, 1000);
  assert.equal(full.get('a', 1000), undefined, 'the oldest query is forgotten');
  assert.deepEqual(full.get(`q${MENTION_CACHE_SIZE - 1}`, 1000), rows);
});
