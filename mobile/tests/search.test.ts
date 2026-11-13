/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchParts, parseThreadSearch, searchQuery, withoutShown, type ThreadHit } from '../src/store/search.ts';
import type { TaskSummary } from '../src/connect/types.ts';
import { demoCall, type DemoHost } from '../src/demo-host.ts';
import { demoSnippet } from '../src/demo/search.ts';
import { fileSearchPhase, moreLabel, rerunQuery, searchPending, TEXT_MIN, textMinTitle } from '../src/ui/file-search.ts';
import { readFileSync } from 'node:fs';
import type { ConnectState } from '../src/store/index.ts';

const hit = (sessionId: string, extra: Partial<ThreadHit> = {}): ThreadHit => ({ sessionId, title: sessionId, projectName: 'p', messageId: 1, snippet: 'x', at: 0, ...extra });

test('queries are trimmed and bounded like the host', () => {
  assert.equal(searchQuery('  billing '), 'billing');
  assert.equal(searchQuery(' a '), null);
  assert.equal(searchQuery(' ab '), null, 'the host needs three characters');
  assert.equal(searchQuery(' abc '), 'abc');
  assert.equal(searchQuery('é'.repeat(200)), 'é'.repeat(200));
  assert.equal(searchQuery('é'.repeat(201)), null);
});

test('replies keep only well-formed rows', () => {
  const parsed = parseThreadSearch({ results: [hit('a', { title: 7 as unknown as string }), { sessionId: 'b' }, null, hit('c')], truncated: true });
  assert.deepEqual(parsed.results.map(r => r.sessionId), ['a', 'c']);
  assert.equal(parsed.results[0].title, '');
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parseThreadSearch(null), { results: [], truncated: false });
  assert.deepEqual(parseThreadSearch({ results: 'no' }), { results: [], truncated: false });
});

test('title matches are not repeated', () => {
  const rows = [{ deviceId: 'mac', hit: hit('a') }, { deviceId: 'mac', hit: hit('b') }, { deviceId: 'pc', hit: hit('a') }];
  assert.deepEqual(withoutShown(rows, new Set(['mac/a'])).map(r => `${r.deviceId}/${r.hit.sessionId}`), ['mac/b', 'pc/a']);
});

test('snippet hits are cut out for bolding', () => {
  assert.deepEqual(matchParts('Fix Billing and billing', 'billing'), [
    { text: 'Fix ', hit: false }, { text: 'Billing', hit: true }, { text: ' and ', hit: false }, { text: 'billing', hit: true },
  ]);
  assert.deepEqual(matchParts('nothing here', 'zz'), [{ text: 'nothing here', hit: false }]);
  assert.deepEqual(matchParts('ab', 'ab'), [{ text: 'ab', hit: true }]);
  assert.deepEqual(matchParts('abc', '  '), [{ text: 'abc', hit: false }]);
});

test('demo snippets centre the hit within 200 characters', () => {
  assert.equal(demoSnippet('Fix the\n\n billing  page', 'BILLING'), 'Fix the billing page');
  const cut = demoSnippet(`${'a'.repeat(500)} needle ${'b'.repeat(500)}`, 'Needle');
  assert.ok([...cut].length <= 200 && cut.startsWith('…') && cut.endsWith('…') && cut.includes('needle'));
  assert.ok(demoSnippet('x'.repeat(300), 'zz').endsWith('…'));
});

const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'App', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null, ...extra,
});

function host(): DemoHost {
  let state = {
    configured: false, ready: true, signedIn: true, connected: true, account: null, deviceId: 'phone', error: null, demo: true, older: {}, teams: {},
    devices: [{ id: 'mac', name: 'Mac', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: { mac: { tasks: [task('a', { title: 'Login' }), task('b'), task('bot', { botId: 'x' })], projects: [], loadedAt: 0 } },
    messages: {
      'mac/a': [
        { id: 1, role: 'user', content: 'fix billing', createdAt: 10, turnDurationMs: null },
        { id: 2, role: 'assistant', content: 'Billing fixed', createdAt: 20, turnDurationMs: null },
        { id: 3, role: 'tool', content: 'billing tool', createdAt: 30, turnDurationMs: null },
      ],
      'mac/b': [{ id: 1, role: 'user', content: 'billing page', createdAt: 40, turnDurationMs: null }],
      'mac/bot': [{ id: 1, role: 'user', content: 'billing', createdAt: 50, turnDurationMs: null }],
    },
    history: {}, sent: {}, live: {}, providers: {}, models: {}, pulls: {}, outdated: {}, bots: {},
  } as unknown as ConnectState;
  return { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: () => undefined, now: () => 5000 };
}

test('the demo searches saved messages newest first, skipping bots and tool output', async () => {
  const reply = await demoCall(host(), 'mac', 'search.threads', { query: 'billing' }) as { results: ThreadHit[]; truncated: boolean };
  assert.deepEqual(reply.results.map(r => [r.sessionId, r.messageId]), [['b', 1], ['a', 2]]);
  assert.equal(reply.results[1].projectName, 'App');
  assert.equal(reply.truncated, false);
  const one = await demoCall(host(), 'mac', 'search.threads', { query: 'billing', limit: 1 }) as { results: ThreadHit[]; truncated: boolean };
  assert.equal(one.results.length, 1);
  assert.equal(one.truncated, true);
  await assert.rejects(Promise.resolve().then(() => demoCall(host(), 'mac', 'search.threads', { query: 'b' })), /3 to 200/);
});

test('checkout search: a Text query under TEXT_MIN shows its empty state, never a skeleton', () => {
  assert.equal(TEXT_MIN, 3);
  assert.equal(fileSearchPhase('text', ''), 'empty');
  assert.equal(fileSearchPhase('text', '  '), 'empty');
  assert.equal(fileSearchPhase('text', 'ab'), 'short');
  assert.equal(fileSearchPhase('text', ' ab '), 'short', 'trimmed first');
  assert.equal(fileSearchPhase('text', 'abc'), 'search');
  // File names search as you type, from the first character.
  assert.equal(fileSearchPhase('names', 'a'), 'search');
  assert.equal(fileSearchPhase('names', ''), 'empty');
  assert.equal(textMinTitle, 'Type at least 3 characters');
});

test('checkout search: older results say a search is answering', () => {
  assert.equal(searchPending(null, 'abc', true), true);
  assert.equal(searchPending(null, 'abc', false), false);
  assert.equal(searchPending({ query: 'abc' }, ' abc ', false), false, 'the same query, trimmed');
  assert.equal(searchPending({ query: 'abc' }, 'abcd', false), true, 'typed past the shown results');
  assert.equal(searchPending({ query: 'abc' }, 'abc', true), true);
});

test('checkout search: a reconnect re-runs only a query that would run', () => {
  assert.equal(rerunQuery('names', 'a'), 'a');
  assert.equal(rerunQuery('text', 'ab'), null);
  assert.equal(rerunQuery('text', ' abc'), ' abc');
  assert.equal(rerunQuery('names', '  '), null);
});

test('checkout search: the N more link counts what is hidden', () => {
  assert.equal(moreLabel(5, 5), null);
  assert.equal(moreLabel(3, 5), null);
  assert.equal(moreLabel(8, 5), '3 more in this file');
});

test('checkout search screen: Searching line, reconnect reload and an accessible N more button', () => {
  const screen = readFileSync(new URL('../src/app/search.tsx', import.meta.url), 'utf8');
  assert.match(screen, /searchPending\(result, query, busy\)/);
  assert.match(screen, />Searching…</);
  assert.match(screen, /useReloadOnReconnect\(device,/);
  assert.match(screen, /<PressScale onPress=\{onPress\} accessibilityRole="button"/);
  assert.doesNotMatch(screen, /<Text onPress=/, 'no bare pressable text');
});
