// W1: one 50,000-byte Markdown reply (headings, paragraphs, lists, code fences, tables, quotes),
// streamed as 2,000 deltas of 25 bytes, one every DELTA_MS. Deterministic: mulberry32 with SEED.
export const SEED = 0x7a3c1e;
export const BYTES = 50_000;
export const DELTA_BYTES = 25;
export const DELTA_MS = 16;
export const SENTINEL = 'End of reply W1.';

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('the render path keeps each streamed delta cheap so a long reply never blocks input while the agent ' +
  'works through files tests and builds we parse markdown once per frame and patch only the changed tail of the ' +
  'document which keeps layout stable and scrolling smooth even when the model writes quickly').split(' ');

function generate() {
  const rand = mulberry32(SEED);
  const pick = list => list[Math.floor(rand() * list.length)];
  const words = n => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const sentence = () => {
    const s = words(8 + Math.floor(rand() * 12));
    const decorated = s.replace(/^(\w+) (\w+)/, rand() < 0.3 ? '**$1** $2' : rand() < 0.5 ? '$1 `$2`' : '$1 [$2](https://example.com/docs)');
    return decorated[0].toUpperCase() + decorated.slice(1) + '.';
  };
  const paragraph = () => Array.from({ length: 2 + Math.floor(rand() * 3) }, sentence).join(' ');
  const blocks = [
    i => `## Step ${i}: ${words(3)}\n\n${paragraph()}\n\n`,
    () => Array.from({ length: 3 + Math.floor(rand() * 3) }, () => `- ${sentence()}\n`).join('') + '\n',
    () => Array.from({ length: 3 }, (_, k) => `${k + 1}. ${sentence()}\n`).join('') + '\n',
    i => '```ts\n' + Array.from({ length: 4 + Math.floor(rand() * 6) }, (_, k) =>
      `export function step${i}_${k}(input: number): number {\n  return input * ${k + 2}; // ${words(4)}\n}\n`).join('') + '```\n\n',
    () => '| File | Change | Lines |\n| --- | --- | ---: |\n' + Array.from({ length: 4 }, () =>
      `| src/${pick(WORDS)}.ts | ${words(4)} | ${Math.floor(rand() * 400)} |\n`).join('') + '\n',
    () => `> ${sentence()}\n\n`,
    () => `${paragraph()}\n\n`,
  ];
  let text = '# Summary of the change\n\n';
  for (let i = 1; text.length < BYTES - 2_000; i++) text += blocks[i % blocks.length](i);
  const tail = `\n${SENTINEL}\n`;
  while (text.length < BYTES - tail.length) text += words(1) + ' ';
  return text.slice(0, BYTES - tail.length) + tail;
}

export const W1_TEXT = generate();
export const W1_DELTAS = Array.from({ length: BYTES / DELTA_BYTES }, (_, i) => W1_TEXT.slice(i * DELTA_BYTES, (i + 1) * DELTA_BYTES));
/** Arrival time of each provider delta, in ms after the first. */
export const W1_TIMES = W1_DELTAS.map((_, i) => i * DELTA_MS);
