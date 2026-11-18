import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const LIMIT = 65536; // Muse's startup-context limit for rules files

test('AGENTS.md stays under the startup limit', () => {
  const size = statSync('AGENTS.md').size;
  assert.ok(size < LIMIT, `AGENTS.md is ${size} bytes; move detail to docs/agent-reference.md`);
});

test('AGENTS.md links to a reference whose sections exist', () => {
  assert.ok(existsSync('docs/agent-reference.md'));
  const agents = readFileSync('AGENTS.md', 'utf8');
  const reference = readFileSync('docs/agent-reference.md', 'utf8');
  const slugs = new Set(
    [...reference.matchAll(/^## (.+)$/gm)].map((m) =>
      m[1].toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-'),
    ),
  );
  const anchors = [...agents.matchAll(/docs\/agent-reference\.md#([\w-]+)/g)].map((m) => m[1]);
  assert.ok(anchors.length > 0);
  for (const anchor of anchors) assert.ok(slugs.has(anchor), `missing section #${anchor}`);
});
