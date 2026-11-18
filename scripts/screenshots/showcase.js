// Appended to src/preview.ts while capturing README screenshots (never shipped): a fuller
// sample workspace, with a finished conversation, tasks in every board column, and replies
// the capture script queues in window.__showcaseReply.
{
  const at = Date.now();
  const base = sessions[1];
  const task = (id, title, provider, model, stage, ago, extra = {}) => ({
    ...base, id, projectId: 'project-1', title, provider, model, status: 'idle', taskStage: stage,
    createdAt: at - ago - 60_000, updatedAt: at - ago, lastResponseAt: stage === 'pending' ? null : at - ago, resumeId: null, issue: undefined, ...extra,
  });
  sessions.push(
    task('session-5', 'Offline sync for the reading list', 'opencode', '', 'in_progress', 40 * 60_000, { status: 'running' }),
    task('session-6', 'Polish the onboarding flow', 'glm', 'glm-5.3', 'review', 3 * 3600_000),
    task('session-7', 'Fix flaky date tests', 'codex', 'gpt-6-astra', 'completed', 26 * 3600_000, { completedAt: at - 26 * 3600_000 }),
    task('session-8', 'Write the v2 migration guide', 'claude', 'opus', 'pending', 5 * 3600_000),
    task('session-14', 'Stabilize the date tests', 'codex', 'gpt-6-astra', 'review', 2 * 3600_000),
    task('session-11', 'Trim the bundle', 'claude', 'opus', 'review', 4 * 3600_000),
  );
  for (const id of ['session-5', 'session-6', 'session-7', 'session-8', 'session-14', 'session-11']) messages[id] = [];

  const tool = (id, name, input, output, ago) => ({ id: ++id_, sessionId: 'session-1', role: 'tool', content: encodeTool({ id, name, status: 'completed', input, output }), createdAt: at - ago });
  let id_ = 500;
  messages['session-1'] = [
    { id: ++id_, sessionId: 'session-1', role: 'user', content: 'Search feels a little slow. Can you make it respond instantly as I type, and keep the keyboard navigation working?', createdAt: at - 420_000 },
    { id: ++id_, sessionId: 'session-1', role: 'assistant', content: 'I’ll trace how the search input updates the results, then check the keyboard interactions.', createdAt: at - 410_000 },
    tool('show-read', 'Read', 'src/components/search.ts', 'export function createSearchIndex(items) { … }', 400_000),
    tool('show-grep', 'Grep', 'buildIndex', 'src/components/search.ts:14\nsrc/library/view.ts:88', 380_000),
    tool('show-edit', 'Edit', 'src/components/search.ts', 'Updated 2 hunks', 330_000),
    tool('show-test', 'Bash', 'npm test', 'PASS src/components/search.test.ts\n  ✓ filters results as the query changes\n  ✓ preserves keyboard selection\n\nTests: 42 passed, 42 total', 300_000),
    { id: ++id_, sessionId: 'session-1', role: 'assistant', createdAt: at - 290_000, content: [
      'Search now updates on every keystroke without rebuilding the index.',
      '',
      '### What changed',
      '',
      '- **One index per dataset.** `buildIndex()` moved out of the input handler and is cached by dataset version.',
      '- **Only visible rows render.** The results list is virtualized, so a 10,000-item library stays under 4 ms per frame.',
      '- **Keyboard navigation kept.** ↑ ↓ and Enter work as before, and the active row stays in view.',
      '',
      '```ts',
      'const index = useMemo(() => buildIndex(items), [items.version]);',
      'const results = useDeferredValue(search(index, query));',
      '```',
      '',
      'All 42 tests pass. Want me to open a pull request?',
    ].join('\n') },
  ];
}
// A finished turn carries a changes marker, like a real run, and the time it took.
{
  const finish = (sessionId, ms) => {
    const history = messages[sessionId];
    history[0].turnDurationMs = ms;
    const marker = { id: ++id, sessionId, role: 'changes', content: '', createdAt: history.at(-1).createdAt };
    turnChanges.finish(marker);
    history.push(marker);
  };
  const at = Date.now();
  const turn = (sessionId, prompt, tools, reply, ms) => {
    messages[sessionId] = [
      { id: ++id, sessionId, role: 'user', content: prompt, createdAt: at - ms - 60_000 },
      ...tools.map(([name, input, output], index) => ({ id: ++id, sessionId, role: 'tool', content: encodeTool({ id: `${sessionId}-${index}`, name, status: 'completed', input, output }), createdAt: at - ms })),
      { id: ++id, sessionId, role: 'assistant', content: reply, createdAt: at - 60_000 },
    ];
    finish(sessionId, ms);
  };
  finish('session-1', 134_000);
  turn('session-6', 'The onboarding steps jump around on small screens. Can you tidy them up?', [['Read', 'src/onboarding/steps.ts', 'export const steps = [ … ]'], ['Edit', 'src/onboarding/steps.css', 'Updated 3 hunks']], [
    'The steps now hold their height, so nothing jumps between them.',
    '',
    '- **Fixed layout.** Each step reserves the height of the tallest one.',
    '- **Small screens.** Below 480 px the progress dots move above the title.',
    '- **Focus.** Moving on puts focus on the new step’s heading.',
  ].join('\n'), 212_000);
  turn('session-11', 'The bundle grew past 300 KB. What can we drop?', [['Bash', 'npm run build -- --report', 'dist/app.js 312 KB']], 'The date library was most of it. Replacing it with `Intl` brings the bundle down to **214 KB**.', 96_000);
  turn('session-14', 'The date tests fail around midnight. Find out why and fix them.', [['Grep', 'new Date()', 'src/lib/dates.test.ts:12\nsrc/lib/dates.test.ts:48'], ['Edit', 'src/lib/dates.test.ts', 'Updated 2 hunks'], ['Bash', 'npm test -- dates', 'PASS src/lib/dates.test.ts\n\nTests: 18 passed, 18 total']], [
    'The tests read the real clock, so any run crossing midnight compared two different days.',
    '',
    '- **Frozen clock.** Every date test now sets the time with `vi.setSystemTime()`.',
    '- **Time zones.** `formatDay()` takes the zone as an argument, so the tests cover UTC and Tokyo.',
    '- **Result.** 18 tests pass, and 200 repeated runs at 23:59:59 stayed green.',
  ].join('\n'), 318_000);
}
