import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The warm-spare pool sizes live in `providers/warm.rs`; Settings, the README, AGENTS.md and
// docs/worker-tokens.md repeat the totals by hand, so a changed limit must change them too.
const WARM = 'src-tauri/src/providers/warm.rs';
const SETTINGS = 'src/settings.ts';
const README = 'README.md';
const AGENTS = 'AGENTS.md';
const WORKER_TOKENS = 'docs/worker-tokens.md';

function rustLimit(source, name) {
  const match = source.match(new RegExp(`^const ${name}: usize = (\\d+);`, 'm'));
  assert.ok(match, `const ${name} not found in ${WARM}`);
  const value = Number(match[1]);
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer, got ${match[1]}`);
  return value;
}

function limits() {
  const source = readFileSync(WARM, 'utf8');
  const limit = rustLimit(source, 'LIMIT');
  const lead = rustLimit(source, 'LEAD_LIMIT');
  return { limit, lead, total: limit + lead };
}

// Markdown wraps lines; compare with whitespace collapsed.
function flat(path) {
  return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
}

test('warm.rs declares both pool limits', () => {
  const { limit, lead, total } = limits();
  assert.equal(total, limit + lead);
});

test('the Settings switch states the total pool size', () => {
  const { total } = limits();
  const source = readFileSync(SETTINGS, 'utf8');
  const entry = source.match(/\{\s*id:\s*'warm-spares'[^\n]*\}/);
  assert.ok(entry, `warm-spares switch not found in ${SETTINGS}`);
  assert.match(entry[0], new RegExp(`\\bup to ${total}\\)`));
});

test('the README states the total pool size', () => {
  const { total } = limits();
  const text = flat(README);
  const start = text.indexOf('**Warm Claude spares');
  assert.ok(start >= 0, `Warm Claude spares entry not found in ${README}`);
  assert.match(text.slice(start, start + 400), new RegExp(`\\bup to ${total} in total\\b`));
});

test('AGENTS.md states the total pool size', () => {
  const { total } = limits();
  const line = readFileSync(AGENTS, 'utf8').split('\n').find((l) => l.includes('warm-spares-off'));
  assert.ok(line, `warm spares summary not found in ${AGENTS}`);
  assert.match(line, new RegExp(`\\bup to ${total}, run\\b`));
});

test('docs/worker-tokens.md states both limits and the total', () => {
  const { limit, lead, total } = limits();
  const text = flat(WORKER_TOKENS);
  const switchStart = text.indexOf('**Warm spare switch');
  assert.ok(switchStart >= 0, 'Warm spare switch section not found');
  assert.match(text.slice(switchStart, switchStart + 800), new RegExp(`\\bup to ${total};`));
  const costStart = text.indexOf('**What a spare costs and saves.**');
  assert.ok(costStart >= 0, 'What a spare costs and saves section not found');
  assert.match(text.slice(costStart, costStart + 300), new RegExp(`\\bat most ${total} in all\\b`));
  assert.match(text, new RegExp(`\\(${limit} ordinary spares,`));
  assert.ok(text.includes(`(\`LEAD_LIMIT\` ${lead})`), `LEAD_LIMIT ${lead} not stated`);
});

// The measured figures are written once in `providers/warm.rs` (from the bench recorded in
// docs/worker-tokens.md) and repeated by hand elsewhere; a re-measurement must update every copy.
const LEAD_SPARE = 'src-tauri/src/lead_spare.rs';
const ARCHITECT_WORKERS = 'docs/architect-workers.md';
// Normalize hyphen/en dash so only the numbers are compared.
const dash = (range) => range.replace(/-/g, '–');

function canonical(pattern, anchor, what) {
  const source = readFileSync(WARM, 'utf8');
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `${anchor} not found in ${WARM}`);
  const match = source.slice(at).match(pattern);
  assert.ok(match, `${what} not found near ${anchor} in ${WARM}`);
  return dash(match[1]);
}

function rangesIn(path, pattern) {
  return [...flat(path).matchAll(new RegExp(pattern.source, 'g'))].map((m) => dash(m[1]));
}

test('every copy states the measured idle memory range from warm.rs', () => {
  // The comment above `MAX_RENEWALS` carries the canonical short-session RSS envelope.
  const source = readFileSync(WARM, 'utf8');
  const decl = source.indexOf('const MAX_RENEWALS');
  assert.ok(decl >= 0, `MAX_RENEWALS not found in ${WARM}`);
  const comment = source.slice(source.lastIndexOf('const LEAD_LIMIT', decl), decl);
  const found = comment.match(/(\d+[–-]\d+)\s+MiB/);
  assert.ok(found, `MiB range not found in the MAX_RENEWALS comment of ${WARM}`);
  const range = dash(found[1]);
  for (const path of [LEAD_SPARE, SETTINGS, README, AGENTS, WORKER_TOKENS, ARCHITECT_WORKERS]) {
    assert.ok(rangesIn(path, /~?(\d+[–-]\d+)\s+MiB/).includes(range), `${path} must state ${range} MiB`);
  }
});

test('every copy states the measured startup saving from warm.rs', () => {
  // The module doc comment at the top of warm.rs carries the canonical saving range.
  const range = canonical(/(\d+\.\d+[–-]\d+\.\d+)\s+s\b/, '//!', 'startup saving range');
  for (const path of [SETTINGS, WORKER_TOKENS]) {
    assert.ok(rangesIn(path, /(\d+\.\d+[–-]\d+\.\d+)\s+s\b/).includes(range), `${path} must state ${range} s`);
  }
});
