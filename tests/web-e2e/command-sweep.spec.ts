import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { cmd, ready } from './helpers';

// Read-only sweep: every brokered command whose name reads state is called with no arguments.
// 200 = works end to end; 400/422 = needs arguments (reported, not failed); anything else fails.
const READ = /^(list_|get_)|_(list|status|snapshot|preferences|settings|load|info|health|usage|catalog|state|summary)$/;
const SKIP = new Set(['get_terminal_activity']);

test('read-only brokered commands answer without 5xx, hangs or adapter errors', async ({ page }) => {
  test.setTimeout(240_000);
  await ready(page);
  const ledger = JSON.parse(readFileSync('tests/fixtures/web-command-coverage.json', 'utf8')).commands as Array<{ command: string; classification: string }>;
  const targets = ledger.filter(c => c.classification === 'broker' && READ.test(c.command) && !SKIP.has(c.command)).map(c => c.command);
  const results: Record<string, number> = {};
  for (const name of targets) results[name] = (await cmd(page, name, {})).status;
  writeFileSync('.web-e2e/sweep.json', JSON.stringify(results, null, 2));
  const broken = Object.entries(results).filter(([, status]) => ![200, 400, 409, 422].includes(status));
  expect(broken, JSON.stringify(broken)).toEqual([]);
  expect(Object.values(results).filter(s => s === 200).length).toBeGreaterThan(20);
});
