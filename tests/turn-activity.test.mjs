import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTurns, mergeLeadTurns, splitLiveExchange, combineChanges, formatDuration, turnLabel } from '../src/turn-activity.ts';

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

const changeSet = id => ({ id, files: [], additions: 0, deletions: 0, truncated: false, concurrent: false });
const wake = (id, createdAt = id * 1000, extra = {}) => message(id, 'coordination', 'Reviewing worker results', createdAt, { coordinationKind: 'worker_review', ...extra });
const merged = input => mergeLeadTurns(groupTurns(input));

test('every wake between two user messages joins one turn, with coordination in the timeline', () => {
  const input = [
    message(1, 'user', 'Build'), message(2, 'tool', tool('spawn')), message(3, 'assistant', 'Delegated.'),
    wake(4), message(5, 'tool', tool('mailbox')), message(6, 'assistant', 'Reviewing.'),
    wake(7), message(8, 'assistant', 'Verified.'),
    message(9, 'user', 'Next'), message(10, 'assistant', 'Sure.'),
  ];
  const original = structuredClone(input);
  const turns = merged(input);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user, input[0]);
  assert.equal(turns[0].coordination, undefined);
  assert.deepEqual(ids(turns[0].activity), [2, 3, 4, 5, 6, 7]);
  assert.equal(turns[0].final, input[7]);
  assert.equal(turns[0].key, 'turn:tool:spawn');
  assert.equal(turns[1].final, input[9]);
  assert.deepEqual(input, original, 'merging must not mutate saved messages');
});

test('a turn that is not a lead exchange passes through untouched', () => {
  const input = groupTurns([
    message(1, 'user', 'Keep working'), message(2, 'assistant', 'First'), message(3, 'changes', '', 3000, { turnChanges: changeSet('a') }),
    message(4, 'assistant', 'Second'), message(5, 'changes', '', 5000, { turnChanges: changeSet('b') }),
    message(6, 'user', 'Again'), message(7, 'assistant', 'Third'),
  ]);
  assert.deepEqual(mergeLeadTurns(input), input);
  mergeLeadTurns(input).forEach((turn, index) => assert.equal(turn, input[index]));
});

test('the newest final is the reply; without one the latest earlier final stays the reply', () => {
  const stopped = merged([
    message(1, 'user', 'Build'), message(2, 'assistant', 'First.'),
    wake(3), message(4, 'assistant', 'Second.'),
    wake(5), message(6, 'tool', tool('check')),
  ]);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].final.id, 4);
  assert.deepEqual(ids(stopped[0].activity), [2, 3, 5, 6]);
  const quiet = merged([message(1, 'user', 'Build'), message(2, 'assistant', 'Done.'), wake(3)]);
  assert.equal(quiet[0].final.id, 2);
  assert.deepEqual(ids(quiet[0].activity), [3]);
});

test('errors, notes and every change set survive in order, including a changes row before a wake', () => {
  const [turn, ...rest] = merged([
    message(1, 'user', 'Build'), message(2, 'assistant', 'First.'), message(3, 'error', 'Lost a worker'), message(4, 'system', 'Note one'),
    message(5, 'changes', '', 5000, { turnChanges: changeSet('first') }),
    wake(6), message(7, 'assistant', 'Second.'), message(8, 'changes', '', 8000, { turnChanges: changeSet('second') }),
    wake(9), message(10, 'error', 'Stopped'), message(11, 'system', 'Note two'),
  ]);
  assert.deepEqual(rest, []);
  assert.deepEqual(ids(turn.errors), [3, 10]);
  assert.deepEqual(ids(turn.notes), [4, 11]);
  assert.deepEqual(turn.earlierChanges.map(changes => changes.id), ['first']);
  assert.equal(turn.changes.id, 'second');
  assert.equal(turn.final.id, 7);
});

test('time sums the segments, leaving out the wait, and says when it is not exact', () => {
  const [exact] = merged([
    message(1, 'user', 'Build', 1000, { turnDurationMs: 2000 }), message(2, 'assistant', 'A', 3000),
    wake(3, 100000, { turnDurationMs: 500 }), message(4, 'assistant', 'B', 100500),
  ]);
  assert.equal(exact.durationMs, 2500);
  assert.equal(exact.estimated, false);
  const [timed] = merged([
    message(1, 'user', 'Build', 1000, { turnDurationMs: 2000 }), message(2, 'assistant', 'A', 3000),
    wake(3, 100000), message(4, 'assistant', 'B', 104000),
  ]);
  assert.equal(timed.durationMs, 6000);
  assert.equal(timed.estimated, true);
  // A segment that did work with no usable time makes the sum a lower bound.
  const [partial] = merged([
    message(1, 'user', 'Build', 1000, { turnDurationMs: 2000 }), message(2, 'assistant', 'A', 3000),
    wake(3, 100000), message(4, 'tool', tool('running'), 104000),
  ]);
  assert.equal(partial.durationMs, 2000);
  assert.equal(partial.estimated, true);
  // A wake that has not done anything yet costs nothing and leaves the time exact.
  const [idle] = merged([message(1, 'user', 'Build', 1000, { turnDurationMs: 2000 }), message(2, 'assistant', 'A', 3000), wake(3, 100000)]);
  assert.equal(idle.durationMs, 2000);
  assert.equal(idle.estimated, false);
  const [unknown] = merged([message(1, 'assistant', 'Earlier'), wake(2), message(3, 'tool', tool('a'))]);
  assert.equal(unknown.durationMs, null);
  assert.equal(unknown.estimated, false);
});

test('a page that starts mid-turn still works, and workers keep the first start', () => {
  const [alone] = merged([wake(3), message(4, 'assistant', 'Only this.')]);
  assert.equal(alone.coordination.id, 3);
  assert.equal(alone.key, 'turn:coordination:3');
  assert.deepEqual(alone.activity, []);
  const [resumed] = merged([wake(3), message(4, 'assistant', 'One.'), wake(5), message(6, 'assistant', 'Two.')]);
  assert.equal(resumed.coordination.id, 3, 'the first label has no earlier card to join');
  assert.deepEqual(ids(resumed.activity), [4, 5]);
  assert.equal(resumed.workerStart, 3000);
  const [unanchored] = merged([message(2, 'assistant', 'Earlier'), wake(3), message(4, 'assistant', 'Later')]);
  assert.equal(unanchored.user, undefined);
  assert.equal(unanchored.coordination, undefined);
  assert.equal(unanchored.key, 'turn:message:2');
  assert.deepEqual(ids(unanchored.activity), [2, 3]);
  assert.equal(unanchored.workerStart, 3000);
  const [anchored] = merged([message(1, 'user', 'Go'), message(2, 'assistant', 'A'), wake(3), message(4, 'assistant', 'B')]);
  assert.equal(anchored.workerStart, 1000);
});

test('a handoff row stays out of the merge', () => {
  const turns = merged([
    message(1, 'user', 'Build'), message(2, 'assistant', 'A'), message(3, 'handoff', '{}'), wake(4), message(5, 'assistant', 'B'),
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[1].key, 'handoff:3');
  assert.equal(turns[2].coordination.id, 4);
});

test('the key does not move as the exchange gains wakes', () => {
  const start = [message(1, 'user', 'Build'), message(2, 'tool', tool('first')), message(3, 'assistant', 'A')];
  const before = merged(start)[0].key;
  const waking = [...start, wake(4)];
  const finished = [...waking, message(5, 'tool', tool('later')), message(6, 'assistant', 'B')];
  assert.equal(merged(waking)[0].key, before);
  assert.equal(merged(finished)[0].key, before);
  assert.equal(splitLiveExchange(merged(waking)).earlier.key, before);
});

test('a live wake takes the whole exchange out of the saved turns, its text readable in the timeline', () => {
  const input = [
    message(1, 'user', 'Older'), message(2, 'assistant', 'Older reply'),
    message(3, 'user', 'Build', 3000, { turnDurationMs: 1000 }), message(4, 'assistant', 'Delegated.'), message(5, 'error', 'Lost one'),
    message(6, 'changes', '', 6000, { turnChanges: changeSet('first') }),
    wake(7),
  ];
  const { saved, earlier } = splitLiveExchange(merged(input));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].final.id, 2);
  assert.equal(earlier.user.id, 3);
  assert.equal(earlier.final, undefined);
  assert.deepEqual(ids(earlier.activity), [4, 7]);
  assert.deepEqual(ids(earlier.errors), [5]);
  assert.equal(earlier.changes.id, 'first');
  assert.equal(earlier.durationMs, 1000);
});

test('an ordinary run has nothing to take out; a resumed page start keeps its label as the lead', () => {
  const ordinary = merged([message(1, 'user', 'Older'), message(2, 'assistant', 'Reply'), message(3, 'user', 'Go')]);
  const split = splitLiveExchange(ordinary);
  assert.equal(split.earlier, undefined);
  assert.equal(split.saved.length, 2);
  // A goal run's next turn is not a wake, so its saved card stays where it is.
  assert.equal(splitLiveExchange(merged([message(1, 'user', 'Go'), message(2, 'assistant', 'A'), message(3, 'changes', '', 3000, { turnChanges: changeSet('a') })])).earlier, undefined);
  assert.deepEqual(splitLiveExchange([]), { saved: [] });
  const { saved, earlier } = splitLiveExchange(merged([wake(3)]));
  assert.deepEqual(saved, []);
  assert.equal(earlier.coordination.id, 3);
  assert.deepEqual(earlier.activity, []);
  const single = splitLiveExchange(merged([wake(3), message(4, 'assistant', 'A'), message(5, 'changes', '', 5000, { turnChanges: changeSet('a') })])).earlier;
  assert.deepEqual(ids(single.activity), [4]);
  assert.equal(single.final, undefined);
});

const run = (id, files, extra = {}) => ({ attributed: true, id, files, truncated: false, concurrent: false, ...extra,
  additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) });
const file = (path, status, additions, deletions, extra = {}) => ({ path, status, additions, deletions, ...extra });

test('a file changed in two runs counts once, its lines summed and marked as summed', () => {
  const runs = [run('a', [file('src/a.ts', 'modified', 3, 1), file('src/b.ts', 'added', 5, 0)]), run('b', [file('src/a.ts', 'modified', 2, 2)])];
  const original = structuredClone(runs);
  const combined = combineChanges(runs);
  assert.deepEqual(combined.files.map(entry => [entry.path, entry.status, entry.additions, entry.deletions]), [['src/a.ts', 'modified', 5, 3], ['src/b.ts', 'added', 5, 0]]);
  assert.equal(combined.files.length, 2);
  assert.equal(combined.additions, 10);
  assert.equal(combined.deletions, 3);
  assert.deepEqual(combined.runs.map(entry => entry.id), ['a', 'b']);
  assert.deepEqual(combined.touched['src/a.ts'], ['a', 'b']);
  assert.deepEqual(combined.touched['src/b.ts'], ['a']);
  assert.match(combined.note, /added up/);
  assert.equal(combined.id, 'exchange:a,b');
  assert.equal(combined.attributed, true);
  assert.deepEqual(runs, original, 'combining must not mutate saved snapshots');
});

test('a rename then an edit is one renamed file under its new name', () => {
  const combined = combineChanges([
    run('a', [file('src/new.ts', 'renamed', 1, 1, { oldPath: 'src/old.ts' })]),
    run('b', [file('src/new.ts', 'modified', 4, 0)]),
  ]);
  assert.equal(combined.files.length, 1);
  assert.deepEqual(combined.files[0], { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed', additions: 5, deletions: 1, binary: false, truncated: false });
  assert.deepEqual(combined.touched['src/new.ts'], ['a', 'b']);
  // Renamed and then renamed back is an edit in place.
  const back = combineChanges([run('a', [file('y.ts', 'renamed', 0, 0, { oldPath: 'x.ts' })]), run('b', [file('x.ts', 'renamed', 0, 0, { oldPath: 'y.ts' })])]);
  assert.deepEqual(back.files.map(entry => [entry.path, entry.status, entry.oldPath]), [['x.ts', 'modified', undefined]]);
  // An added file renamed later is still an added file.
  const added = combineChanges([run('a', [file('n.ts', 'added', 2, 0)]), run('b', [file('m.ts', 'renamed', 0, 0, { oldPath: 'n.ts' })])]);
  assert.deepEqual(added.files.map(entry => [entry.path, entry.status, entry.oldPath]), [['m.ts', 'added', undefined]]);
});

test('a file added and then deleted leaves the list, and the note says so', () => {
  const combined = combineChanges([
    run('a', [file('tmp.txt', 'added', 4, 0), file('keep.ts', 'modified', 1, 0)]),
    run('b', [file('tmp.txt', 'deleted', 0, 4)]),
  ]);
  assert.deepEqual(combined.files.map(entry => entry.path), ['keep.ts']);
  assert.match(combined.note, /1 file was added and removed again/);
  assert.equal(combined.additions, 5);
  assert.equal(combined.deletions, 4);
  // Deleted and then added back is an edit; modified and then deleted is a deletion.
  const back = combineChanges([run('a', [file('x.ts', 'deleted', 0, 3)]), run('b', [file('x.ts', 'added', 3, 0)])]);
  assert.deepEqual(back.files.map(entry => entry.status), ['modified']);
  const gone = combineChanges([run('a', [file('x.ts', 'modified', 1, 0)]), run('b', [file('x.ts', 'deleted', 0, 5)])]);
  assert.deepEqual(gone.files.map(entry => entry.status), ['deleted']);
  // A renamed file later deleted is gone under its first name.
  const renamedGone = combineChanges([run('a', [file('b.ts', 'renamed', 0, 0, { oldPath: 'a.ts' })]), run('b', [file('b.ts', 'deleted', 0, 2)])]);
  assert.deepEqual(renamedGone.files.map(entry => [entry.path, entry.status, entry.oldPath]), [['a.ts', 'deleted', undefined]]);
});

test('truncated, concurrent and failed captures and unknown counts survive the combination', () => {
  const combined = combineChanges([
    run('a', [file('a.ts', 'modified', null, null)], { truncated: true }),
    run('b', [file('a.ts', 'modified', 2, 0), file('img.png', 'modified', null, null, { binary: true })], { concurrent: true, error: 'Disk busy' }),
  ]);
  assert.equal(combined.truncated, true);
  assert.equal(combined.concurrent, true);
  assert.equal(combined.error, 'Disk busy');
  assert.deepEqual(combined.files.map(entry => [entry.path, entry.additions, entry.deletions, entry.binary]), [['a.ts', null, null, false], ['img.png', null, null, true]]);
  assert.equal(combineChanges([run('a', [], { truncated: true }), run('b', [], { error: 'x' }), run('c', [], { error: 'x' })]).error, 'x');
});
