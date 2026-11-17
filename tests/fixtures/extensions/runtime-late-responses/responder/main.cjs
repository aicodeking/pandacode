// R0508 fixture: a service that answers what waits for the user after its hook budget, with panda.tasks.respond.
// It observes approval.pending and question.pending; after `delayMs` (2,000 ms by default, past nothing: answers never
// expire while the request is open) it denies a shell call whose command matches `deny` with that rule's reason, and
// answers a question whose ids are all in `answers`. Anything else stays with the user. Each outcome is recorded:
// { requestId, ok, code? }, so a refusal (StaleContext when the user answered first, PermissionDenied after a revoke)
// is visible. Commands:
//   sample.late-responder/respond  args { taskId, requestId, answer } -> answers one request now (the fixture action)
//   sample.late-responder/control  args { op: 'list' | 'configure', ... } -> { outcomes, resolved, rules }
exports.service = async (panda, lifetime) => {
  const rules = { delayMs: 2000, deny: [{ match: 'rm -rf', reason: 'Outside the project.' }], answers: {} };
  const outcomes = [];
  const resolved = [];
  const timers = new Set();
  const later = work => {
    const timer = setTimeout(() => { timers.delete(timer); void work(); }, rules.delayMs);
    timers.add(timer);
  };
  const respond = async (taskId, requestId, answer) => {
    try {
      await panda.tasks.respond(taskId, requestId, answer);
      outcomes.push({ requestId, ok: true });
    } catch (error) {
      outcomes.push({ requestId, ok: false, code: error?.code ?? String(error?.message ?? error) });
    }
  };
  const hooks = [
    panda.hooks.on('approval.pending', request => {
      const command = typeof request?.input?.command === 'string' ? request.input.command : '';
      const rule = request?.tool?.kind === 'shell' ? rules.deny.find(entry => command.includes(entry.match)) : undefined;
      if (rule) later(() => respond(request.taskId, request.requestId, { approved: false, reason: rule.reason }));
    }),
    panda.hooks.on('question.pending', request => {
      const ids = (request?.questions ?? []).map(question => question.id);
      if (ids.length && ids.every(id => id in rules.answers)) {
        later(() => respond(request.taskId, request.requestId, { answers: Object.fromEntries(ids.map(id => [id, rules.answers[id]])) }));
      }
    }),
    panda.hooks.on('approval.resolved', ended => { resolved.push({ requestId: ended.requestId, by: ended.by }); }),
    panda.hooks.on('question.resolved', ended => { resolved.push({ requestId: ended.requestId, by: ended.by }); }),
  ];
  await Promise.allSettled(hooks.map(hook => hook.ready));
  panda.commands.register('sample.late-responder/respond', async context => {
    const { taskId, requestId, answer } = context.args ?? {};
    await respond(taskId, requestId, answer);
    return outcomes.at(-1);
  });
  panda.commands.register('sample.late-responder/control', async context => {
    const args = context.args ?? {};
    if (args.op === 'configure') {
      if (Number.isInteger(args.delayMs) && args.delayMs >= 0) rules.delayMs = args.delayMs;
      if (Array.isArray(args.deny)) rules.deny = args.deny;
      if (args.answers && typeof args.answers === 'object') rules.answers = args.answers;
    } else if (args.op !== 'list') throw new Error('InvalidShape');
    return { outcomes: [...outcomes], resolved: [...resolved], rules: { ...rules } };
  });
  lifetime.onStop(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const hook of hooks) hook.dispose();
  });
};
