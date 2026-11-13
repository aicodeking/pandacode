/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { decodeHandoff, HANDOFF_SUMMARY_MAX, handoffTitle } from '../src/store/handoff.ts';
import { reuseRows, turnRows } from '../src/store/turns.ts';

const msg = (id: number, role: string, content = `${role}${id}`): Message => ({ id, role, content, createdAt: id, turnDurationMs: null });
const notice = (from: string, to: string, summary = 'Switched harness.') => JSON.stringify({ fromProvider: from, toProvider: to, summary });

test('decodes the host’s handoff notice', () => {
  assert.deepEqual(decodeHandoff(msg(1, 'handoff', notice('claude', 'codex'))), { fromProvider: 'claude', toProvider: 'codex', summary: 'Switched harness.' });
});

test('rejects other roles, bad JSON, unknown providers and missing fields', () => {
  assert.equal(decodeHandoff(msg(1, 'system', notice('claude', 'codex'))), null);
  assert.equal(decodeHandoff(msg(1, 'handoff', '{not json')), null);
  assert.equal(decodeHandoff(msg(1, 'handoff', 'null')), null);
  assert.equal(decodeHandoff(msg(1, 'handoff', '"text"')), null);
  assert.equal(decodeHandoff(msg(1, 'handoff', notice('claude', 'someone'))), null);
  assert.equal(decodeHandoff(msg(1, 'handoff', JSON.stringify({ fromProvider: 'claude', toProvider: 'codex' }))), null);
  assert.equal(decodeHandoff(msg(1, 'handoff', JSON.stringify({ fromProvider: 'claude', toProvider: 'codex', summary: 4 }))), null);
});

test('caps the summary as the desktop does', () => {
  const decoded = decodeHandoff(msg(1, 'handoff', notice('kimi', 'github-copilot', 'x'.repeat(5000))));
  assert.equal(decoded?.summary.length, HANDOFF_SUMMARY_MAX);
});

test('the card title names both harnesses', () => {
  const names: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
  assert.equal(handoffTitle({ fromProvider: 'claude', toProvider: 'codex', summary: '' }, id => names[id] ?? id), 'Switched from Claude Code to Codex');
});

test('a handoff is its own row between turns, never a work step', () => {
  const rows = turnRows([msg(1, 'user'), msg(2, 'tool'), msg(3, 'assistant'), msg(4, 'handoff', notice('claude', 'codex')), msg(5, 'user'), msg(6, 'assistant')]);
  assert.deepEqual(rows.map(r => r.id), ['u1', 'w2', 'r3', 'h4', 'u5', 'r6']);
  const work = rows[1];
  assert.ok(work.kind === 'work');
  assert.deepEqual(work.steps.map(s => s.id), [2]);
  const handoff = rows[3];
  assert.ok(handoff.kind === 'handoff');
  assert.equal(handoff.handoff.toProvider, 'codex');
});

test('an undecodable handoff shows nothing and folds into no turn', () => {
  const rows = turnRows([msg(1, 'user'), msg(2, 'assistant'), msg(3, 'handoff', 'garbage'), msg(4, 'user')]);
  assert.deepEqual(rows.map(r => r.id), ['u1', 'r2', 'u4']);
});

test('a handoff right after the prompt keeps the prompt’s turn apart', () => {
  const rows = turnRows([msg(1, 'handoff', notice('codex', 'claude')), msg(2, 'user'), msg(3, 'tool'), msg(4, 'assistant')]);
  assert.deepEqual(rows.map(r => r.kind), ['handoff', 'user', 'work', 'reply']);
});

test('an unchanged handoff row is reused on refetch', () => {
  const messages = [msg(1, 'user'), msg(2, 'handoff', notice('claude', 'codex'))];
  const first = turnRows(messages);
  assert.equal(reuseRows(first, turnRows(messages.map(m => ({ ...m })))), first);
});
