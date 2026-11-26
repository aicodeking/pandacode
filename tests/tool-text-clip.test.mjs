// clip() names files, paths and commands a reader may copy out of a tool row, so it may only fold ASCII
// whitespace: JavaScript's `\s` also matches U+202F (the narrow no-break space macOS puts in screenshot
// names), U+00A0 and other Unicode spaces, and rewriting one of those yields a path that is not on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clip } from '../src/tool-text.ts';

const NARROW = '\u202f';
// The real name of a macOS screenshot, as written by screencapture.
const SHOT = `Screenshot 2026-11-26 at 6.56.16${NARROW}PM.png`;

test('clip keeps a narrow no-break space verbatim', () => {
  assert.equal(clip(`a${NARROW}b`), `a${NARROW}b`);
  assert.equal(clip(`a${NARROW}b`, 48), `a${NARROW}b`);
  assert.notEqual(clip(`a${NARROW}b`), 'a b');
});

test('clip keeps other Unicode spaces verbatim', () => {
  assert.equal(clip('a\u00a0b'), 'a\u00a0b');
  assert.equal(clip('a\u2009b'), 'a\u2009b');
  assert.equal(clip('a\u3000b'), 'a\u3000b');
});

test('clip still folds ASCII whitespace runs to one space', () => {
  assert.equal(clip('a\n\nb'), 'a b');
  assert.equal(clip('a\t b'), 'a b');
  assert.equal(clip('a\r\n b'), 'a b');
  assert.equal(clip('a\v\f b'), 'a b');
});

test('clip trims ASCII whitespace at both ends', () => {
  assert.equal(clip('  x  '), 'x');
  assert.equal(clip('\n\t x \t\n'), 'x');
});

test('a real screenshot name survives a round trip through clip', () => {
  assert.equal(clip(SHOT, 48), SHOT);
  assert.equal(clip(`cp "${SHOT}" out.png`, 400), `cp "${SHOT}" out.png`);
});

test('over-long text is cut to the limit and ends in an ellipsis', () => {
  const long = 'x'.repeat(200);
  const shown = clip(long, 20);
  assert.equal(shown.length, 20);
  assert.ok(shown.endsWith('\u2026'), shown);
  assert.equal(clip('x'.repeat(19), 20), 'x'.repeat(19), 'a value at the limit is kept whole');
});

test('a cut never leaves ASCII whitespace before the ellipsis', () => {
  const shown = clip('aaaa '.repeat(40), 10);
  assert.ok(shown.endsWith('\u2026'), shown);
  assert.doesNotMatch(shown, /[ \t\n\v\f\r]\u2026$/, shown);
});

test('a non-ASCII space inside the kept text is not trimmed before the ellipsis', () => {
  // limit 5 keeps 4 characters, then the ellipsis: the narrow space is the second of them.
  assert.equal(clip(`x${NARROW}${'y'.repeat(100)}`, 5), `x${NARROW}yy\u2026`);
});
