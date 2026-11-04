import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTurns, formatDuration, turnLabel } from '../src/turn-activity.ts';

const message = (id, role, content, createdAt = id * 1000, extra = {}) =>
  ({ id, sessionId: 'task', role, content, createdAt, ...extra });
const tool = id => JSON.stringify({ type: 'tool_activity', version: 1, id,
  name: 'Read', status: 'completed', input: 'README.md', output: 'Project notes' });
const ids = messages => messages.map(message => message.id);

test('app coordination starts a separate turn without becoming a user or assistant message', () => {
  const changes = { id: 'review', files: [], additions: 0, deletions: 0, truncated: false, concurrent: false };
  const realJson = '{"workers":["a","b"],"round":3}';
  const input = [
    message(1, 'user', realJson), message(2, 'assistant', 'I have delegated the work.'),
    message(3, 'coordination', 'Checking worker updates', 3000, { coordinationKind: 'worker_update', turnDurationMs: 1500, turnChanges: changes }),
    message(4, 'tool', tool('mailbox')), message(5, 'assistant', 'The workers have the answers they need.'),
    message(6, 'coordination', 'Reviewing worker results', 6000, { coordinationKind: 'worker_review' }),
    message(7, 'assistant', 'The work is verified.'),
  ];
  const turns = groupTurns(input);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].user.content, realJson);
  assert.equal(turns[0].final.id, 2);
  assert.equal(turns[1].user, undefined);
  assert.equal(turns[1].coordination, input[2]);
  assert.deepEqual(ids(turns[1].activity), [4]);
  assert.equal(turns[1].final.id, 5);
  assert.equal(turns[1].durationMs, 1500);
  assert.equal(turns[1].estimated, false);
  assert.equal(turns[1].changes, changes);
  assert.equal(turns[2].coordination, input[5]);
  assert.equal(turns[2].key, 'turn:coordination:6');
  assert.deepEqual(turns[2].activity, []);
  assert.equal(turns[2].durationMs, 1000);
});

test('completed goal markers split autonomous turns and stay outside tool activity', () => {
  const changes = id => ({ id, files: [], additions: 0, deletions: 0, truncated: false, concurrent: false });
  const turns = groupTurns([
    message(1, 'user', 'Keep working'), message(2, 'tool', tool('edit-1')),
    message(3, 'assistant', 'First result'), message(4, 'changes', '', 4000, { turnChanges: changes('first') }),
    message(5, 'assistant', 'Continuing'), message(6, 'tool', tool('edit-2')),
    message(7, 'assistant', 'Second result'), message(8, 'changes', '', 8000, { turnChanges: changes('second') }),
    message(9, 'assistant', 'Still working'),
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].changes.id, 'first');
  assert.equal(turns[0].final.content, 'First result');
  assert.equal(turns[1].changes.id, 'second');
  assert.equal(turns[1].final.content, 'Second result');
  assert.deepEqual(ids(turns[1].activity), [5, 6]);
  assert.equal(turns[2].changes, undefined);
  const [partial] = groupTurns([message(8, 'changes', '', 8000, { turnChanges: changes('second') })]);
  assert.equal(partial.changes.id, 'second');
  assert.deepEqual(partial.activity, []);
  assert.equal(partial.final, undefined);
});

test('ordinary completion uses saved user snapshot without inventing changes on old history', () => {
  const changes = { id: 'saved', files: [], additions: 0, deletions: 0, truncated: false, concurrent: false };
  const turns = groupTurns([
    message(1, 'user', 'Read'), message(2, 'assistant', 'Done'),
    message(3, 'user', 'Edit', 3000, { turnChanges: changes }), message(4, 'assistant', 'Updated'),
  ]);
  assert.equal(turns[0].changes, undefined);
  assert.equal(turns[1].changes, changes);
});

test('groups each user turn with ordered commentary and tools, keeping its final answer outside', () => {
  const messages = [
    message(1, 'user', 'Explore'), message(2, 'assistant', 'I’ll read the files.'),
    message(3, 'tool', tool('read-1')), message(4, 'assistant', 'I found the entry point.'),
    message(5, 'tool', tool('read-2')), message(6, 'assistant', 'This is a coding app.'),
    message(7, 'user', 'Change it', 7000, { turnDurationMs: 2500 }),
    message(8, 'tool', tool('edit-1')), message(9, 'assistant', 'Changed.'),
  ];
  const original = structuredClone(messages);
  const turns = groupTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user, messages[0]);
  assert.deepEqual(ids(turns[0].activity), [2, 3, 4, 5]);
  assert.equal(turns[0].final, messages[5]);
  assert.deepEqual(turns[0].errors, []);
  assert.equal(turns[0].key, 'turn:tool:read-1');
  assert.equal(turns[0].durationMs, 5000);
  assert.equal(turns[0].estimated, true);
  assert.equal(turns[1].durationMs, 2500);
  assert.equal(turns[1].estimated, false);
  assert.deepEqual(messages, original, 'grouping must not mutate saved messages');
});

test('legacy calls omit only redundant exact completion placeholders, preserving recorded output', () => {
  const [turn] = groupTurns([
    message(1, 'user', 'Inspect'), message(2, 'tool', 'Bash'),
    message(3, 'tool', 'Tool finished'), message(4, 'tool', 'Read README.md\nProject notes'),
    message(5, 'tool', 'Tool finished\nRead 15 lines'), message(6, 'assistant', 'Done'),
  ]);
  assert.deepEqual(ids(turn.activity), [2, 4, 5]);
  assert.equal(turn.key, 'turn:message:2');
  const [placeholderOnly] = groupTurns([message(1, 'tool', 'Tool finished')]);
  assert.deepEqual(ids(placeholderOnly.activity), [1]);
  const [mixed] = groupTurns([
    message(1, 'user', 'Inspect'), message(2, 'tool', tool('read')),
    message(3, 'tool', 'Tool finished'), message(4, 'assistant', 'Done'),
  ]);
  assert.deepEqual(ids(mixed.activity), [2]);
});

test('normalized tools provide the stable turn key even after earlier legacy activity', () => {
  const [turn] = groupTurns([
    message(1, 'user', 'Inspect'), message(2, 'tool', 'Read'),
    message(3, 'tool', tool('native-1')), message(4, 'tool', tool('native-2')),
  ]);
  assert.equal(turn.key, 'turn:tool:native-1');
});

test('a partial history page retains an unanchored turn without using the next user’s timestamp', () => {
  const turns = groupTurns([
    message(2, 'assistant', 'Earlier work'), message(3, 'tool', tool('earlier')),
    message(4, 'assistant', 'Earlier answer'), message(5, 'user', 'Next question'),
    message(6, 'assistant', 'Next answer'),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user, undefined);
  assert.deepEqual(ids(turns[0].activity), [2, 3]);
  assert.equal(turns[0].final.id, 4);
  assert.equal(turns[0].durationMs, null);
  assert.equal(turns[0].estimated, false);
  assert.equal(turns[1].key, 'turn:user:5');
  assert.equal(turns[1].durationMs, 1000);
});

test('failures are always separate from collapsed activity and can end a timed turn without an answer', () => {
  const [turn] = groupTurns([
    message(1, 'user', 'Run tests'), message(2, 'tool', tool('test')),
    message(3, 'error', 'Provider disconnected'), message(4, 'error', 'Retry needed'),
  ]);
  assert.deepEqual(ids(turn.activity), [2]);
  assert.deepEqual(ids(turn.errors), [3, 4]);
  assert.equal(turn.final, undefined);
  assert.equal(turn.durationMs, 3000);
  const [errorOnly] = groupTurns([message(2, 'error', 'Interrupted')]);
  assert.equal(errorOnly.key, 'turn:message:2');
  assert.deepEqual(errorOnly.activity, []);
  assert.equal(errorOnly.durationMs, null);
});

test('exact zero duration is preserved and invalid exact timing falls back only to sensible timestamps', () => {
  const [zero] = groupTurns([
    message(1, 'user', 'Quick task', 1000, { turnDurationMs: 0 }),
    message(2, 'assistant', 'Done', 4000),
  ]);
  assert.equal(zero.durationMs, 0);
  assert.equal(zero.estimated, false);
  for (const turnDurationMs of [undefined, null, -1, NaN, Infinity, '10']) {
    const [turn] = groupTurns([
      message(1, 'user', 'Task', 1000, { turnDurationMs }),
      message(2, 'assistant', 'Done', 4000),
    ]);
    assert.equal(turn.durationMs, 3000);
    assert.equal(turn.estimated, true);
  }
  for (const [start, toolTime, end] of [[undefined, 2000, 3000], [1000, NaN, 3000],
    [1000, 2000, Infinity], [-1, 2000, 3000], [1000, 900, 3000], [1000, 3000, 2000]]) {
    const messages = [message(1, 'user', 'Task'), message(2, 'tool', 'Read'), message(3, 'assistant', 'Done')];
    [messages[0].createdAt, messages[1].createdAt, messages[2].createdAt] = [start, toolTime, end];
    const [turn] = groupTurns(messages);
    assert.equal(turn.durationMs, null);
    assert.equal(turn.estimated, false);
  }
});

test('empty and pending turns do not invent activity or a duration', () => {
  assert.deepEqual(groupTurns([]), []);
  const turns = groupTurns([message(1, 'user', 'First'), message(2, 'user', 'Second')]);
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.deepEqual(turn.activity, []);
    assert.equal(turn.final, undefined);
    assert.equal(turn.durationMs, null);
  }
  const pendingMessages = [message(1, 'user', 'Inspect'), message(2, 'tool', tool('read'))];
  const [pending] = groupTurns(pendingMessages);
  assert.deepEqual(ids(pending.activity), [2]);
  assert.equal(pending.durationMs, null);
  assert.equal(pending.estimated, false);
  pendingMessages[0].turnDurationMs = 0;
  const [completedWithoutAnswer] = groupTurns(pendingMessages);
  assert.equal(completedWithoutAnswer.durationMs, 0);
  assert.equal(completedWithoutAnswer.estimated, false);
});

test('formats whole elapsed seconds and labels estimates explicitly', () => {
  for (const [ms, expected] of [[0, '0s'], [999, '0s'], [1000, '1s'], [59999, '59s'],
    [60000, '1m 0s'], [83999, '1m 23s'], [3600000, '1h 0m 0s'], [3723000, '1h 2m 3s'],
    [90000000, '25h 0m 0s']]) assert.equal(formatDuration(ms), expected);
  assert.equal(turnLabel(83000), 'Worked for 1m 23s');
  assert.equal(turnLabel(83000, true), 'Worked for about 1m 23s');
  assert.equal(turnLabel(0), 'Worked for 0s');
  assert.equal(turnLabel(null), 'Tool activity');
  assert.equal(turnLabel(NaN), 'Tool activity');
});

test('assistant updates remain before trailing tools and only a trailing answer becomes final', () => {
  const input = [message(1, 'user', 'Build'), message(2, 'assistant', 'Inspecting the project'),
    message(3, 'tool', tool('read')), message(4, 'assistant', 'Implementing the fix'), message(5, 'tool', tool('edit'))];
  const [working] = groupTurns(input);
  assert.equal(working.final, undefined);
  assert.deepEqual(ids(working.activity), [2, 3, 4, 5]);
  const [finished] = groupTurns([...input, message(6, 'assistant', 'Verified the fix')]);
  assert.deepEqual(ids(finished.activity), [2, 3, 4, 5]);
  assert.equal(finished.final.content, 'Verified the fix');
  const [legacy] = groupTurns([...input, message(6, 'assistant', 'Verified the fix'), message(7, 'tool', 'Tool finished')]);
  assert.equal(legacy.final.content, 'Verified the fix');
  assert.deepEqual(ids(legacy.activity), [2, 3, 4, 5]);
});

test('a system note stays out of the fold and never takes the reply', () => {
  const [turn] = groupTurns([message(1, 'user', 'Go'), message(2, 'tool', tool('a')), message(3, 'assistant', 'Done: fixed X'), message(4, 'system', 'A report was lost.')]);
  assert.deepEqual(ids([turn.final]), [3]);
  assert.deepEqual(ids(turn.notes), [4]);
  assert.deepEqual(ids(turn.activity), [2]);
});
