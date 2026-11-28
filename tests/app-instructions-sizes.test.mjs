import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pandaInstructions, pandaSources, rustConst, rustFnString } from '../scripts/agent-bench/gui.mjs';

// The app instructions are assembled in `app_instructions()` (src-tauri/src/app_instructions.rs);
// docs/worker-tokens.md and docs/agent-loop-benchmark.md quote their sizes by hand, so a changed
// constant must change those numbers too.
const APP = 'src-tauri/src/app_instructions.rs';
const WORKER_TOKENS = 'docs/worker-tokens.md';
const BENCHMARK = 'docs/agent-loop-benchmark.md';
// What Claude Code calls the explorer (`providers::explore_name("claude")`).
const EXPLORE = 'pandacode_explore';

// The exact concat lines of `app_instructions()`; the sizes below assume this order.
const MANAGED_ORDER = 'return [track, TURN_ENDS, &look, reuse].concat();';
const TASK_ORDER =
  '[session_titles::GUIDANCE, run, turn_changes::instruction(), TURN_ENDS, &look, reuse, RICH_QUESTIONS, GENERATIVE_UI, progress].concat()';

const bytes = (text) => Buffer.byteLength(text, 'utf8');
// "6,325" -> 6325
const num = (text) => Number(text.replace(/,/g, ''));
// Markdown wraps lines; compare with whitespace collapsed.
const flat = (path) => readFileSync(path, 'utf8').replace(/\s+/g, ' ');

/** `app_instructions()` for local macOS Claude, explore on, agent-made tools off, not a chat. */
function rustSizes() {
  const src = pandaSources();
  const c = (name) => rustConst(src.appInstructions, name);
  const changes = rustFnString(src.changes, 'instruction');
  const lookBase = c('LOOK').replace('{explore}', EXPLORE);
  const look = lookBase + c('EDIT_CLAUDE');
  const lookReadOnly = lookBase.trimEnd();
  const lead = [
    rustConst(src.titles, 'GUIDANCE'),
    rustConst(src.run, 'INSTRUCTIONS'),
    changes,
    c('TURN_ENDS'),
    look,
    c('RICH_QUESTIONS'),
    c('GENERATIVE_UI'),
    c('VISUAL_PROGRESS'),
  ].join('');
  return {
    lead: bytes(lead),
    writer: bytes([changes, c('TURN_ENDS'), look].join('')),
    readOnly: bytes([c('TURN_ENDS'), lookReadOnly].join('')),
    editClaude: bytes(c('EDIT_CLAUDE')),
    editOther: bytes(c('EDIT_OTHER')),
    guidance: bytes(rustConst(src.titles, 'GUIDANCE')),
  };
}

test('app_instructions() still concatenates in the order these sizes assume', () => {
  const source = readFileSync(APP, 'utf8');
  assert.ok(source.includes(MANAGED_ORDER), `managed-worker concat changed in ${APP}`);
  assert.ok(source.includes(TASK_ORDER), `task concat changed in ${APP}`);
});

test('worker-tokens.md states the lead and writer-worker sizes', () => {
  const { lead, writer } = rustSizes();
  const match = flat(WORKER_TOKENS).match(/lead ([\d,]+) B and writer worker ([\d,]+) B for every Claude-family model/);
  assert.ok(match, `lead/writer sizes line not found in ${WORKER_TOKENS}`);
  assert.equal(num(match[1]), lead, 'lead size');
  assert.equal(num(match[2]), writer, 'writer worker size');
});

test('worker-tokens.md states the read-only worker size', () => {
  const { readOnly } = rustSizes();
  const match = flat(WORKER_TOKENS).match(/A read-only worker is ([\d,]+) B:/);
  assert.ok(match, `read-only worker size not found in ${WORKER_TOKENS}`);
  assert.equal(num(match[1]), readOnly);
});

test('worker-tokens.md states the edit-text and title-guidance sizes', () => {
  const { editClaude, editOther, guidance } = rustSizes();
  const text = flat(WORKER_TOKENS);
  const edit = text.match(/`EDIT_CLAUDE` is ([\d,]+) B and `EDIT_OTHER` ([\d,]+) B\./);
  assert.ok(edit, `EDIT_CLAUDE/EDIT_OTHER sizes not found in ${WORKER_TOKENS}`);
  assert.equal(num(edit[1]), editClaude, 'EDIT_CLAUDE');
  assert.equal(num(edit[2]), editOther, 'EDIT_OTHER');
  const titles = text.match(/`session_titles::GUIDANCE` ([\d,]+) B/);
  assert.ok(titles, `GUIDANCE size not found in ${WORKER_TOKENS}`);
  assert.equal(num(titles[1]), guidance, 'GUIDANCE');
});

test('agent-loop-benchmark.md states the live bench instruction sizes', () => {
  const src = pandaSources();
  const plain = pandaInstructions(src);
  const worker = pandaInstructions(src, { worker: true });
  const match = flat(BENCHMARK).match(
    /Live sizes, from `node -e` on `pandaInstructions\(pandaSources\(\)\)` in `gui\.mjs`: plain task ([\d,]+) characters \(([\d,]+) bytes\), worker ([\d,]+) characters(?: \(([\d,]+) bytes\))?\./,
  );
  assert.ok(match, `live sizes line not found in ${BENCHMARK}`);
  assert.equal(num(match[1]), plain.length, 'plain task characters');
  assert.equal(num(match[2]), bytes(plain), 'plain task bytes');
  assert.equal(num(match[3]), worker.length, 'worker characters');
  if (match[4] !== undefined) assert.equal(num(match[4]), bytes(worker), 'worker bytes');
});
