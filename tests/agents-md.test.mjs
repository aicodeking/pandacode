import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

// Muse truncates a rules file past its 65,536-byte subagent startup
// limit (issue #320). AGENTS.md is loaded into every session, so it stays
// well under that limit; detail lives in docs/agent-reference.md instead.
const LIMIT = 65_536;
const HEADROOM = 60_000;

test('AGENTS.md stays under the Muse startup context limit', async () => {
  const { size } = await stat(new URL('../AGENTS.md', import.meta.url));
  assert.ok(size < HEADROOM, `AGENTS.md is ${size} bytes; keep it under ${HEADROOM} (hard limit ${LIMIT}). Move detail to docs/agent-reference.md or docs/.`);
});

test('AGENTS.md points at the detailed agent reference, and its anchors exist', async () => {
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const reference = await readFile(new URL('../docs/agent-reference.md', import.meta.url), 'utf8');
  const slugs = new Set(
    reference.split('\n')
      .filter(line => line.startsWith('### '))
      .map(line => line.slice(4).trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')),
  );
  assert.ok(slugs.size > 20, 'reference keeps its per-area sections');
  const anchors = [...agents.matchAll(/agent-reference\.md#([a-z0-9-]+)/g)].map(match => match[1]);
  assert.ok(anchors.length > 20, 'AGENTS.md indexes the reference sections');
  assert.deepEqual(anchors.filter(anchor => !slugs.has(anchor)), [], 'every AGENTS.md reference anchor resolves');
});
