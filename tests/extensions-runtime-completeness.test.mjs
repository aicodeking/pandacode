// Runtime acceptance map (R1302): every decided permission maps to an author page, a native owner and a spec that exist,
// the retained refusals carry a non-security reason, and the page states what is not closed. Written, not run (user
// decision 2026-11-16: tests only in the final phase). It reads only files the repository carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { MANIFEST_CAPABILITIES } from '../src/extensions/contracts.ts';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const PAGE = 'docs/extensions/runtime-acceptance.md';
const page = read(PAGE);
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `${heading} section`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
};
const cells = line => line.split('|').slice(1, -1).map(cell => cell.trim());
const rowsOf = body => body.split('\n').filter(line => line.startsWith('| `') || line.startsWith('| Q'));
const paths = text => [...text.matchAll(/`([^`\s]+\.(?:md|rs|ts|mjs|json))`/g)].map(match => match[1]);

test('runtime acceptance: the fifty permissions each map to an existing page, native owner and spec', () => {
  const rows = rowsOf(section(page, 'Permission map'));
  const names = rows.map(row => cells(row)[0].replaceAll('`', ''));
  assert.deepEqual([...names].sort(), [...MANIFEST_CAPABILITIES].sort(), 'exactly the decided permission names');
  assert.equal(new Set(names).size, names.length, 'one row per permission');
  for (const row of rows) {
    const [permission, doc, native, spec] = cells(row);
    for (const cell of [doc, native, spec]) assert.ok(cell.length > 3, `${permission}: an empty cell`);
    for (const path of paths(`${doc} ${native} ${spec}`)) assert.ok(existsSync(path), `${permission}: missing ${path}`);
    assert.ok(paths(doc).length === 1 && paths(native).length === 1, `${permission}: one page and one native owner`);
    // The only permission without a spec is the one whose companion line was skipped by a user decision.
    if (paths(spec).length === 0) assert.equal(permission, '`harness.companions`', `${permission}: no spec`);
  }
});

test('runtime acceptance: no credential read, no unowned row and the count drift is recorded', () => {
  assert.ok(!MANIFEST_CAPABILITIES.some(name => name.startsWith('credentials.') && name !== 'credentials.use'), 'credentials.use is the only credential permission');
  const counts = section(page, 'Reconciliation counts');
  assert.match(counts, /417 classified rows/);
  assert.match(counts, /419 source-id occurrences/);
  assert.match(counts, /130 rows/);
  assert.match(counts, /drift/);
  assert.match(counts, /not claimed/, 'full closure is not claimed while the per-row walk is open');
  assert.doesNotMatch(page.replace(counts, ''), /\bUNCLEAR\b/, 'an UNCLEAR row outside the historical count');
});

test('runtime acceptance: the refusals owned by R1302 keep a reason that is not security', () => {
  const rows = rowsOf(section(page, 'Refusal-test reconciliation owned by R1302 (Q066, Q067, Q128)'));
  assert.deepEqual(rows.map(row => cells(row)[0]), ['Q066', 'Q067', 'Q128']);
  for (const row of rows) {
    const [id, source, refusal, reason] = cells(row);
    assert.ok(refusal.length > 30 && reason.length > 30, `${id}: state the retained refusal and its reason`);
    assert.match(reason, /predictab|recovery|stability|irreversib|fault isolation/i, `${id}: a non-security reason`);
    assert.doesNotMatch(reason, /\bsecurity\b|\bto be safe\b/i, `${id}: ADR-0005 allows no restriction for security`);
    for (const path of paths(source)) assert.ok(existsSync(path), `${id}: missing ${path}`);
  }
});

test('runtime acceptance: what is not closed is named, never claimed', () => {
  const open = section(page, 'Not closed, stated plainly');
  for (const phrase of [/R0601-R0606/, /A5/, /live Claude hook capture/, /UnsupportedRuntime/, /installed and live is\s+pending/, /have not run/]) assert.match(open, phrase);
  assert.match(page, /tests written, not run/);
  assert.doesNotMatch(page, /fully delivered|all gates passed/i);
});
