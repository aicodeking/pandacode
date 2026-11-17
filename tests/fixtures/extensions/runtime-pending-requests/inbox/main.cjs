// R0507 fixture: an inbox of what waits for the user. A background service that observes approval.pending,
// approval.resolved, question.pending and question.resolved, and keeps the list of open requests by requestId.
// Deliveries are one-way and can be lost (a restart, a full queue), so the inbox rebuilds its list from
// panda.hooks.pending() when it starts, whenever a task goes idle, and when asked: the host's answer is the current
// open set, so a request resolved while the inbox was not listening never comes back.
// The command `sample.pending-inbox/control` is the only way to look at or steer it, chosen by `args.op`:
//   list   -> { approvals: [requestId], questions: [requestId], revision, resyncs, seen }
//   resync -> rebuild from panda.hooks.pending(), then list
//   reset  -> forget everything (as a fresh service would)
const EVENTS = ['approval.pending', 'approval.resolved', 'question.pending', 'question.resolved', 'task.idle'];
exports.service = async (panda, lifetime) => {
  const state = { approvals: new Map(), questions: new Map(), revision: null, resyncs: 0, seen: [] };
  const list = () => ({
    approvals: [...state.approvals.keys()], questions: [...state.questions.keys()],
    revision: state.revision, resyncs: state.resyncs, seen: [...state.seen],
  });
  const resync = async () => {
    const snapshot = await panda.hooks.pending();
    state.approvals = new Map(snapshot.approvals.map(item => [item.requestId, item]));
    state.questions = new Map(snapshot.questions.map(item => [item.requestId, item]));
    state.revision = snapshot.revision;
    state.resyncs += 1;
  };
  const handlers = {
    'approval.pending': payload => { state.approvals.set(payload.requestId, payload); },
    'question.pending': payload => { state.questions.set(payload.requestId, payload); },
    'approval.resolved': payload => { state.approvals.delete(payload.requestId); },
    'question.resolved': payload => { state.questions.delete(payload.requestId); },
    'task.idle': () => resync().catch(() => {}),
  };
  const hooks = EVENTS.map(event => panda.hooks.on(event, async payload => {
    state.seen.push({ event, requestId: payload?.requestId ?? null, by: payload?.by ?? null });
    await handlers[event](payload);
  }));
  await Promise.allSettled(hooks.map(hook => hook.ready));
  await resync().catch(() => {});
  panda.commands.register('sample.pending-inbox/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'list': return list();
      case 'resync': await resync(); return list();
      case 'reset': state.approvals.clear(); state.questions.clear(); state.seen.length = 0; state.revision = null; return list();
      default: throw new Error('InvalidShape');
    }
  });
  lifetime.onStop(() => { for (const hook of hooks) hook.dispose(); });
};
