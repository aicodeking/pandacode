// R0404B fixture: a background service that decides a Council, steers one worker and answers a usage-limit pause when it is told
// to, by the command `sample.runtime-tasks-flow/flow` (the panel button of the acceptance, the browser spec and the native test).
// `op` is one of:
//   council  -> panda.tasks.council(taskId, decision)               (accept, dismiss, keepFixing)
//   worker   -> panda.tasks.worker(taskId, workerId, action)        (retry, resume, skip, stop)
//   limit    -> panda.tasks.limit(taskId, action, options?)         (continue, resume, dismiss; options { connection })
//   refuse   -> any of the above with `args.call` naming it, answering the refusal as `{ refused: <code>, path, ids }`
//               instead of throwing (nothing changed)
//   state    -> what the service holds: every flow so far and every refusal
// The package never names a credential and never touches pairing or remote access; the calls have no such option.
exports.service = async (panda, lifetime) => {
  const state = { done: [], refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ done: state.done.length, refused: state.refused }) });
  const call = async (name, args) => {
    switch (name) {
      case 'council': return panda.tasks.council(args.taskId, args.decision);
      case 'worker': return panda.tasks.worker(args.taskId, args.workerId, args.action);
      case 'limit': return panda.tasks.limit(args.taskId, args.action, args.options);
      default: throw new Error(`unknown call ${name}`);
    }
  };
  const run = async args => {
    switch (args.op) {
      case 'council': case 'worker': case 'limit': {
        await call(args.op, args);
        state.done.push({ op: args.op, taskId: args.taskId });
        return null;
      }
      case 'refuse':
        try { await call(args.call, args); return { refused: null }; } catch (error) {
          const code = String(error?.code ?? error?.message ?? error);
          state.refused.push(code);
          return { refused: code, path: error?.path ?? null, ids: Array.isArray(error?.ids) ? error.ids : [] };
        }
      case 'state': return state;
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.runtime-tasks-flow/flow', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });
  await report();
};
