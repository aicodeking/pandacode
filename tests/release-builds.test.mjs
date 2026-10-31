import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { targets } from '../scripts/release/common.mjs';

// The release workflow builds one target per entry in scripts/release/common.mjs. Every
// place that lists builds has to name them all, or a platform is told there is no
// build for it while a release carries one.
test('the website and the README name every published build', async () => {
  const site = await readFile(new URL('../website/src/lib/distribution.ts', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const missing = [];
  for (const [target, config] of Object.entries(targets)) {
    if (!site.includes(config.asset)) missing.push(`${target}: the website does not link ${config.asset}`);
    if (!readme.includes(config.asset)) missing.push(`${target}: the README does not link ${config.asset}`);
  }
  assert.deepEqual(missing, []);
});
