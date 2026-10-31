import test from 'node:test';
import assert from 'node:assert/strict';
import { blockBoundaries } from '../src/streaming-markdown.ts';
import { parseMarkdown, renderMarkdown } from '../src/enriched-markdown.ts';
import { markdownCache } from '../src/dom.ts';

const parts = (value, ends = blockBoundaries(value)) => [0, ...ends].map((start, i) => value.slice(start, ends[i] ?? value.length));
const render = async value => renderMarkdown(await parseMarkdown(value));

const SAMPLES = [
  `## Plan\n\nSome **bold** text with \`code\` and a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n- loose three\n\nAfter the list.\n\n1. first\n2. second\n\n3) other\n\nDone.\n`,
  "Intro\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n~~~\nx\n\n```\n\ny\n~~~\n\n````md\n```\ninner\n```\n\nstill code\n````\n\nEnd.\n",
  `| a | b |\n| --- | --- |\n| 1 | $x^2$ |\n\n$$\nE = mc^2\n\n$$\n\nInline $a$ math.\n\n> quote\n\n> second quote\n\n    indented code\n\n    more code\n\nText\n===\n\n---\n\n> [!NOTE]\n> Careful.\n\nlast line`,
  `- item\n\n  continued paragraph\n\n      code in item\n\n* star\n\n+ plus\n\n10. ten\n\nplain *emphasis* :followup[Run tests]{prompt="Run the tests"}\n`,
];

test('blank lines inside fences and between list items never settle a block', () => {
  const fenced = 'a\n\n```\nx\n\ny\n```\n\nb\n';
  assert.deepEqual(parts(fenced), ['a\n\n', '```\nx\n\ny\n```\n\n', 'b\n']);
  assert.deepEqual(parts('- a\n\n- b\n\n  more\n\nc\n'), ['- a\n\n- b\n\n  more\n\n', 'c\n']);
  // A fence whose info string holds a backtick is not a fence.
  assert.deepEqual(parts('```a`\n\nb\n'), ['```a`\n\n', 'b\n']);
  // The line after the blank must be complete, and the open fence keeps the rest open.
  assert.deepEqual(blockBoundaries('a\n\nb'), []);
  assert.deepEqual(blockBoundaries('a\n\n```\nx\n\ny\n'), [3]);
  // Syntax that reaches across blank lines turns splitting off.
  assert.deepEqual(blockBoundaries('a\n\n[x]: https://x.dev\n\nb\n'), []);
  assert.deepEqual(blockBoundaries('<details>\n\n<summary>s</summary>\n\nbody\n\n</details>\n'), []);
});

test('offsets only grow as a stream appends text', () => {
  for (const sample of SAMPLES) {
    let previous = [];
    for (let end = 1; end <= sample.length; end++) {
      const ends = blockBoundaries(sample.slice(0, end));
      assert.deepEqual(ends.slice(0, previous.length), previous, JSON.stringify(sample.slice(0, end)));
      previous = ends;
    }
  }
});

test('rendering settled blocks apart equals rendering the whole, at every streamed prefix', async () => {
  for (const sample of SAMPLES) {
    for (let end = 25; end < sample.length + 25; end += 25) {
      const value = sample.slice(0, end);
      const ends = blockBoundaries(value), tail = value.slice(ends.at(-1) ?? 0);
      const whole = await render(value);
      // As the painter does: new settled blocks in one parse, the open tail in another…
      assert.equal(await render(value.slice(0, ends.at(-1) ?? 0)) + await render(tail), whole, JSON.stringify(value));
      // …and block by block, as they settled over time.
      assert.equal((await Promise.all(parts(value, ends).map(render))).join(''), whole, JSON.stringify(value));
    }
  }
});

test('the formatted-Markdown cache is an LRU bounded by size', () => {
  const big = 'x'.repeat(Math.floor(markdownCache.limit / 3));
  markdownCache.set('a', big); markdownCache.set('b', big);
  assert.equal(markdownCache.get('a'), big);
  markdownCache.set('a', big); // touch: b is now the oldest
  markdownCache.set('c', big);
  assert.equal(markdownCache.get('b'), undefined, 'the oldest entry is evicted');
  assert.equal(markdownCache.get('a'), big);
  assert.equal(markdownCache.get('c'), big);
  assert.ok(markdownCache.size() <= markdownCache.limit);
  markdownCache.set('huge', 'x'.repeat(markdownCache.limit + 1));
  assert.equal(markdownCache.get('huge'), undefined, 'an entry over the bound is never kept');
  for (const key of ['a', 'c']) markdownCache.delete(key);
  assert.equal(markdownCache.size(), 0);
});
