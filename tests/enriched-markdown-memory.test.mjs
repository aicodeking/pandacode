import test from 'node:test';
import assert from 'node:assert/strict';
import { LARGE_INPUT, MEMORY_CAP, parseMarkdown, parserMemory, renderMarkdown } from '../src/enriched-markdown.ts';

const render = async value => renderMarkdown(await parseMarkdown(value));
// Self-contained blocks, so a repeat renders as the repeat of one rendering.
const BLOCK = '## Step\n\nSome **bold** text, `code`, $x^2$ and a [link](https://example.com).\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quote\n\n';

// First in the file, so the engine's first start races the throwaway ones too.
test('concurrent large parses and engine starts leave WebAssembly.instantiate alone', async () => {
  const original = WebAssembly.instantiate;
  const big = BLOCK.repeat(Math.ceil(LARGE_INPUT / BLOCK.length) + 1);
  const [a, b, one, c] = await Promise.all([render(big), render(big), render(BLOCK), render(big)]);
  assert.equal(WebAssembly.instantiate, original);
  assert.equal(a, one.repeat(big.length / BLOCK.length));
  assert.equal(b, a);
  assert.equal(c, a);
  const live = await parserMemory();
  assert.ok(live > 0 && live < MEMORY_CAP);
  // Later starts never patch: watch for any swap while two more throwaway engines start.
  let swapped = false;
  const watch = setInterval(() => { if (WebAssembly.instantiate !== original) swapped = true; }, 0);
  try { await Promise.all([render(big), render(big)]); } finally { clearInterval(watch); }
  assert.equal(swapped, false);
  assert.equal(WebAssembly.instantiate, original);
  assert.equal(await parserMemory(), live);
});

test('a 2 MB message renders the same without growing the long-lived parser', async () => {
  const one = await render(BLOCK);
  const before = await parserMemory();
  assert.ok(before > 0 && before < MEMORY_CAP);
  const big = BLOCK.repeat(Math.ceil(2 * 1024 * 1024 / BLOCK.length));
  assert.ok(big.length > LARGE_INPUT);
  assert.equal(await render(big), one.repeat(big.length / BLOCK.length));
  assert.equal(await parserMemory(), before);
  assert.equal(await render(BLOCK), one);
});

test('repeated inputs just under the large-input limit keep the live parser under the cap', async () => {
  const chunk = BLOCK.repeat(Math.floor(LARGE_INPUT / BLOCK.length));
  const one = await render(BLOCK);
  // Inputs under the large-input limit grow the live parser only up to what one of them needs.
  for (let i = 0; i < 8; i++) assert.equal(await render(chunk), one.repeat(chunk.length / BLOCK.length));
  assert.ok(await parserMemory() < MEMORY_CAP);
});
