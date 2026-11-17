// R0404 fixture: a background service that controls a task when it is told to, by the command
// `sample.runtime-tasks-control/control` (the panel button of the acceptance, the browser spec and the native test).
// `op` is one of:
//   stop      -> panda.tasks.stop(taskId)
//   setMode   -> panda.tasks.setMode(taskId, mode)
//   configure -> panda.tasks.configure(taskId, change)   (harness, model, effort, team, connection, bot, target, stage)
//   compact   -> panda.tasks.compact(taskId)
//   refuse    -> any of the above with `args.call` naming it, answering the refusal as `{ refused: <code>, path, ids }`
//                instead of throwing (nothing changed)
//   state     -> what the service holds: every control so far and every refusal
// The package never names a credential, never pairs a machine and never asks for remote access; the calls have no such option.
// A hook may never change the mode: `setMode` from a hook handler is refused by the host, so this service only ever calls it
// from its own command.
exports.service = async (panda, lifetime) => {
  const state = { done: [], refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ done: state.done.length, refused: state.refused }) });
  const call = async (name, args) => {
    switch (name) {
      case 'stop': return panda.tasks.stop(args.taskId);
      case 'setMode': return panda.tasks.setMode(args.taskId, args.mode);
      case 'configure': return panda.tasks.configure(args.taskId, args.change);
      case 'compact': return panda.tasks.compact(args.taskId);
      default: throw new Error(`unknown call ${name}`);
    }
  };
  const run = async args => {
    switch (args.op) {
      case 'stop': case 'setMode': case 'configure': case 'compact': {
        await call(args.op, args);
        state.done.push({ op: args.op, taskId: args.taskId });
        return null;
      }
      case 'refuse':
        try { await call(args.call, args); return { refused: null }; } catch (error) {
          const code = String(error?.code ?? error?.message ?? error);
          state.refused.push(code);
          return { refused: code, ids: Array.isArray(error?.ids) ? error.ids : [] };
        }
      case 'state': return state;
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.runtime-tasks-control/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });
  await report();
};
