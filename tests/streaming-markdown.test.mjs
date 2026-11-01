import test from 'node:test';
import assert from 'node:assert/strict';
import { blockBoundaries, finalHtml, reconcile, scanBlocks } from '../src/streaming-markdown.ts';
import { parseMarkdown, renderMarkdown } from '../src/enriched-markdown.ts';
import { markdownCache } from '../src/dom.ts';
import { W1_TEXT } from '../bench/t3-compare/workload.mjs';

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

test('a scan carried across a stream finds the same offsets as a full scan, at every prefix', () => {
  const late = 'a\n\nb\n\n```\nx\n\n```\n\nc\n\n<details>\n\nd\n\ne\n';
  for (const sample of [...SAMPLES, late, W1_TEXT.slice(0, 12_000)]) {
    let scan;
    for (let end = 0; end <= sample.length; end += sample === W1_TEXT.slice(0, 12_000) ? 7 : 1) {
      const value = sample.slice(0, end);
      scan = scanBlocks(value, scan);
      assert.deepEqual(blockBoundaries(value, scan), blockBoundaries(value), JSON.stringify(value));
    }
  }
  // Text that is not an extension of the scanned text starts over.
  const scan = scanBlocks('a\n\nb\n\nc\n');
  for (const other of ['a\n\n```\nb\n\nc\n', 'x\n', '', 'a\n\nb\n\n[c]: https://x.dev\n']) {
    assert.deepEqual(blockBoundaries(other, scanBlocks(other, scan)), blockBoundaries(other), JSON.stringify(other));
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

test('an open fence renders line by line: each chunk of lines under the opener joins to the whole code', async () => {
  const code = async value => (await render(value)).match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1];
  const bodies = ['const a = 1;\n\n\n  indented\n\tconst b = `x`;\n``\n``` not a closer\n~~~\n<b>&amp;</b>\nlast', '\n\nx\n  \ny'];
  for (const opener of ['```ts\n', '````md\n', '~~~\n', '  ```\n']) {
    for (const body of bodies) {
      const value = opener + body, lines = body.split(/(?<=\n)/);
      const at = scanBlocks('a\n\n' + value);
      assert.equal(at.fenceAt, 3, 'the scan knows where the open fence started');
      for (let cut = 0; cut <= lines.length; cut++) {
        // The painter keeps the code of the complete lines and renders only the lines added after them.
        const head = lines.slice(0, cut).join(''), rest = lines.slice(cut).join('');
        if (!scanBlocks(opener + head).fence) break; // a closed fence is painted whole
        assert.equal((await code(opener + head)) + (await code(opener + rest)), await code(value), JSON.stringify([head, rest]));
      }
    }
  }
});

test('a deferred cache entry is built only when read, once', async () => {
  let built = 0;
  markdownCache.defer('streamed', async () => { built++; return '<p>streamed</p>'; });
  assert.equal(built, 0);
  assert.equal(markdownCache.get('streamed'), undefined, 'reading the cache never builds it');
  assert.equal(await markdownCache.settle('streamed'), '<p>streamed</p>');
  assert.equal(markdownCache.get('streamed'), '<p>streamed</p>');
  assert.equal(markdownCache.settle('streamed'), undefined, 'built entries are ordinary entries');
  assert.equal(built, 1);
  markdownCache.defer('dropped', async () => { built++; return 'x'; });
  markdownCache.forgo('dropped');
  assert.equal(markdownCache.settle('dropped'), undefined);
  markdownCache.defer('failed', async () => { throw new Error('no renderer'); });
  assert.equal(await markdownCache.settle('failed'), undefined, 'a failed build falls back to a whole parse');
  markdownCache.delete('streamed');
  assert.equal(built, 1);
  assert.equal(markdownCache.size(), 0);
});

test('a finished stream is drawn from its settled HTML plus one render of the rest', async () => {
  for (const sample of SAMPLES) {
    // The stream as the painter leaves it at some frame: settled HTML for every block before the tail.
    for (let end = 25; end < sample.length; end += 25) {
      const prefix = sample.slice(0, end), ends = blockBoundaries(prefix), tailAt = ends.at(-1) ?? 0;
      const state = { source: prefix.slice(0, tailAt), settledHtml: await Promise.all(parts(prefix.slice(0, tailAt), ends.slice(0, -1)).filter(Boolean).map(render)), scan: undefined };
      const asked = [];
      const html = await finalHtml(state, sample, text => { asked.push(text); return render(text); });
      assert.equal(html, await render(sample), JSON.stringify(prefix));
      assert.deepEqual(asked, [sample.slice(state.source.length)], 'only the text after the settled blocks is parsed');
    }
  }
  // Text that no longer extends the settled blocks is parsed whole.
  const asked = [];
  const state = { source: 'a\n\n', settledHtml: [await render('a\n\n')], scan: undefined };
  assert.equal(await finalHtml(state, 'b\n\nc\n', text => { asked.push(text); return render(text); }), await render('b\n\nc\n'));
  assert.deepEqual(asked, ['b\n\nc\n']);
});

// Just enough of the DOM for reconcile, recording every change it makes to the painted tree.
const changes = [];
class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); changes.push('append'); return child; }
  replaceChild(child, old) { this.childNodes[this.childNodes.indexOf(old)] = child; child.parentNode = this; changes.push('replace'); }
  remove() { const siblings = this.parentNode?.childNodes; if (siblings) { siblings.splice(siblings.indexOf(this), 1); changes.push('remove'); } this.parentNode = null; }
  isEqualNode(other) {
    return this.nodeName === other.nodeName && this.nodeValue === other.nodeValue && this.childNodes.length === other.childNodes.length
      && JSON.stringify(this.attributes ?? []) === JSON.stringify(other.attributes ?? []) && this.childNodes.every((child, i) => child.isEqualNode(other.childNodes[i]));
  }
}
class FakeText extends FakeNode {
  nodeType = 3; nodeName = '#text';
  constructor(data) { super(); this.data = data; }
  get nodeValue() { return this.data; }
  get length() { return this.data.length; }
  appendData(more) { this.data += more; changes.push('text'); }
}
class FakeElement extends FakeNode {
  nodeType = 1; nodeValue = null;
  constructor(name, attributes = {}, children = []) {
    super(); this.nodeName = name; this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }));
    for (const child of children) { child.parentNode = this; this.childNodes.push(child); }
  }
  hasAttribute(name) { return this.attributes.some(a => a.name === name); }
  getAttribute(name) { return this.attributes.find(a => a.name === name)?.value ?? null; }
  setAttribute(name, value) { this.removeAttribute(name, true); this.attributes.push({ name, value }); changes.push('attribute'); }
  removeAttribute(name, quiet) { this.attributes = this.attributes.filter(a => a.name !== name); if (!quiet) changes.push('attribute'); }
}
globalThis.Text = FakeText; globalThis.Element = FakeElement;
const el = (name, attributes, ...children) => new FakeElement(name, attributes, children.map(c => typeof c === 'string' ? new FakeText(c) : c));

test('reconcile keeps unchanged tail nodes and only appends what streamed in', () => {
  const tableRow = () => el('TR', {}, el('TD', { align: 'left' }, 'cell'), el('TD', {}, el('CODE', {}, 'x')));
  const target = el('DIV', {}, el('H2', {}, 'Settled'), '\n', el('TABLE', {}, el('TBODY', {}, tableRow())), '\n', el('P', {}, 'Strea'));
  const [settled, , table, , paragraph] = target.childNodes, row = table.childNodes[0].childNodes[0];
  changes.length = 0;
  reconcile(target, [el('TABLE', {}, el('TBODY', {}, tableRow(), tableRow())), new FakeText('\n'), el('P', {}, 'Streaming')], 2);
  assert.deepEqual(changes, ['append', 'text'], 'a new row and the grown text, nothing else');
  assert.equal(target.childNodes[0], settled);
  assert.equal(target.childNodes[2], table);
  assert.equal(table.childNodes[0].childNodes[0], row, 'the unchanged row is the same node');
  assert.equal(target.childNodes[4], paragraph);
  assert.equal(paragraph.childNodes[0].data, 'Streaming');
  // A block that changed kind is replaced; one that changed an attribute keeps its node.
  changes.length = 0;
  reconcile(target, [el('TABLE', { class: 'wide' }, el('TBODY', {}, tableRow(), tableRow())), new FakeText('\n'), el('PRE', {}, 'Streaming')], 2);
  assert.deepEqual(changes, ['attribute', 'replace']);
  assert.equal(target.childNodes[2], table);
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
